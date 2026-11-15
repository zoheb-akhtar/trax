import { router } from 'expo-router';
import { createContext, use, useEffect, useRef, useState, type ReactNode } from 'react';

import { useDevice } from '@/device/device-provider';
import { useRideHistory } from '@/history/history-provider';
import { haptic } from '@/lib/haptics';
import { hush, say, sayAfter, setMuted } from '@/lib/voice';
import { useNav } from '@/nav/nav-provider';
import { useRideUi } from '@/ride-ui/ride-ui-provider';
import { useSecurity } from '@/security/security-provider';
import { useSettings } from '@/settings/settings-provider';

import { explainError, runTurn, wasRejected, type AgentMessage } from './agent';
import { makeClient } from './client';
import { IDLE_RESET_MS, MAX_HISTORY_MESSAGES } from './config';
import {
  proxyCanHear,
  VoiceRecorder,
  type HeardResult,
  type RecorderControl,
} from './recorder';
import { canListen, listen } from './speech';
import type { AgentWorld } from './tools';

export type TranscriptLine = {
  id: number;
  /** you: the owner. velo: the agent's answer. did: something the agent did. problem: a failure. */
  kind: 'you' | 'velo' | 'did' | 'problem';
  text: string;
};

type AgentContextValue = {
  enabled: boolean;
  open: boolean;
  setOpen(open: boolean): void;
  /** Tap-to-talk: starts listening, or finishes early if already listening. */
  talk(): void;
  listening: boolean;
  /** Offering one-tap questions, where the microphone can't be used (Expo Go) */
  choosing: boolean;
  /** The words recognised so far while listening */
  heard: string;
  /** Recording has stopped and the words are being worked out */
  transcribing: boolean;
  thinking: boolean;
  /** True from the start of a question until a few seconds after the answer */
  active: boolean;
  /** Hides the caption and stops listening or speaking. */
  dismiss(): void;
  /** The lines of the question being handled now (or just answered) */
  current: TranscriptLine[];
  transcript: TranscriptLine[];
  /** A question the agent is waiting on before it acts, e.g. "Disarm Velo?" */
  confirming: string | null;
  answer(yes: boolean): void;
  ask(text: string): void;
  /**
   * Velo speaking up by itself: says a line aloud and notes it in the conversation. If a
   * question is in progress it waits until that is over.
   */
  announce(text: string): void;
  /** True for a short while after the agent itself planned a route, so it isn't briefed twice. */
  routedByAgentRecently(): boolean;
  reset(): void;
};

/** How long the answer stays on screen after it has been given. */
const CAPTION_LINGER_MS = 9000;
/** A confirmation nobody answers counts as "no" after this long. */
const CONFIRM_TIMEOUT_MS = 20000;
/** After the agent plans a route, the separate route briefing stays quiet this long. */
const AGENT_ROUTE_QUIET_MS = 30000;

const AgentContext = createContext<AgentContextValue | null>(null);

/** Velo's AI agent: holds the conversation and lets the model act on the rest of the app. */
export function AgentProvider({ children }: { children: ReactNode }) {
  const settings = useSettings();
  const device = useDevice();
  const trip = useNav();
  const security = useSecurity();
  const { rides } = useRideHistory();
  const ui = useRideUi();

  const [open, setOpenState] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [heard, setHeard] = useState('');
  const [active, setActive] = useState(false);
  const [turnFrom, setTurnFrom] = useState(0);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const ear = useRef<RecorderControl | null>(null);
  /** True from a tap on the mic until what was said has been worked out. */
  const hearing = useRef(false);
  /** A line Velo wanted to say while a question was in progress. */
  const waitingLine = useRef<string | null>(null);
  const agentRoutedAt = useRef(0);

  const history = useRef<AgentMessage[]>([]);
  const lastAsked = useRef(0);
  const nextId = useRef(1);
  const busy = useRef(false);
  const resolveConfirm = useRef<((yes: boolean) => void) | null>(null);

  const add = (kind: TranscriptLine['kind'], text: string) => {
    const id = nextId.current++;
    setTranscript((lines) => [...lines, { id, kind, text }]);
    return id;
  };

  // The caption lingers for a moment after the answer, then gets out of the way.
  const settled = active && !listening && !thinking && !confirming;
  useEffect(() => {
    if (!settled) return;
    const timer = setTimeout(() => {
      setActive(false);
      setChoosing(false);
    }, CAPTION_LINGER_MS);
    return () => clearTimeout(timer);
  }, [settled, transcript.length]);

  const answer = (yes: boolean) => {
    resolveConfirm.current?.(yes);
    resolveConfirm.current = null;
    setConfirming(null);
  };

  // Tools run long after this render, so they read the app's state through a ref kept current.
  const world = useRef<AgentWorld | null>(null);
  useEffect(() => {
    world.current = {
      device,
      trip,
      nav: trip.nav,
      security,
      rides,
      ui: {
        ...ui,
        openScreen: (screen) => router.navigate(screen === 'ride' ? '/' : `/${screen}`),
      },
      confirm: (question) =>
        new Promise<boolean>((resolve) => {
          resolveConfirm.current?.(false);
          // Nobody answering counts as no, so the agent (and the mic) are never stuck waiting.
          const timer = setTimeout(() => {
            if (resolveConfirm.current === settle) answer(false);
          }, CONFIRM_TIMEOUT_MS);
          const settle = (yes: boolean) => {
            clearTimeout(timer);
            resolve(yes);
          };
          resolveConfirm.current = settle;
          setActive(true); // the question needs a tap, so make sure it is on screen
          setConfirming(question);
          say(question, true);
        }),
      noteAgentRoute: () => {
        agentRoutedAt.current = Date.now();
      },
    };
  });

  const reset = () => {
    if (busy.current) return; // the turn in progress is still writing to the conversation
    history.current = [];
    setTranscript([]);
    answer(false);
  };

  const ask = async (raw: string) => {
    const text = raw.trim();
    if (!text || busy.current || !world.current) return;
    if (!settings.agentUrl.trim()) {
      setTurnFrom(add('problem', 'Set the agent server address in the Device tab first.'));
      setActive(true);
      return;
    }

    // Long conversations are started afresh rather than trimmed, which keeps tool calls paired.
    const now = Date.now();
    if (now - lastAsked.current > IDLE_RESET_MS || history.current.length > MAX_HISTORY_MESSAGES) {
      history.current = [];
    }
    lastAsked.current = now;

    busy.current = true;
    setChoosing(false);
    setThinking(true);
    setActive(true);
    setTurnFrom(add('you', text));
    let before = history.current.length;
    let toolsRan = 0;
    const turn = () =>
      runTurn({
        client: makeClient(settings.agentUrl, settings.agentToken),
        history: history.current,
        userText: text,
        world: () => world.current!,
        onTool: (label) => {
          toolsRan += 1;
          add('did', label);
        },
      });
    try {
      let reply: string;
      try {
        reply = await turn();
      } catch (error) {
        // The earlier conversation was refused: forget it and ask once more on its own. Not if
        // anything was already done this turn, which asking again would do a second time.
        if (!wasRejected(error) || before === 0 || toolsRan > 0) throw error;
        history.current = [];
        before = 0;
        reply = await turn();
      }
      add('velo', reply);
      haptic.tap();
      say(reply, true);
    } catch (error) {
      // Drop the half-finished exchange so the next question starts from a valid history.
      history.current.length = before;
      const message = explainError(error);
      add('problem', message);
      say(message, true);
    } finally {
      busy.current = false;
      setThinking(false);
      answer(false);
      sayWaitingLine();
    }
  };

  /** Says the line Velo held back while a question was in progress, now that it is over. */
  const sayWaitingLine = () => {
    const line = waitingLine.current;
    if (!line || busy.current || hearing.current) return;
    waitingLine.current = null;
    setTurnFrom(add('velo', line));
    setActive(true);
    sayAfter(line);
  };

  const talk = async () => {
    if (ear.current) return ear.current.finish(); // a second tap means "I'm done talking"
    if (busy.current || hearing.current) return; // still working out the last question
    hearing.current = true;
    hush();
    haptic.tap();
    setTurnFrom(nextId.current);
    setActive(true);
    setHeard('');

    if (!canListen()) {
      // No on-device recognition (Expo Go): record, and let the proxy work out the words.
      // If the proxy can't do that either, offer questions to tap instead.
      const proxy = await proxyCanHear(settings.agentUrl);
      if (proxy !== 'ready') {
        hearing.current = false;
        if (proxy === 'no-speech') return setChoosing(true);
        const message = "I can't reach the Velo agent server. Check its address in the Device tab.";
        add('problem', message);
        say(message, true);
        return;
      }
      setChoosing(false);
      setListening(true);
      setMuted(true); // no spoken alerts while the microphone is open
      setRecording(true);
      return;
    }
    setChoosing(false);
    setListening(true);
    setMuted(true);
    const session = listen(setHeard);
    ear.current = session;
    heardSomething(await session.result);
  };

  const heardSomething = (outcome: HeardResult) => {
    ear.current = null;
    hearing.current = false;
    setMuted(false);
    setRecording(false);
    setTranscribing(false);
    setListening(false);

    if (outcome.ok) return ask(outcome.text);
    if (outcome.reason === 'cancelled') {
      sayWaitingLine();
      return; // the owner stopped it on purpose: nothing to say
    }
    if (outcome.reason === 'denied') {
      const message = 'Velo needs microphone access. Turn it on in Settings.';
      add('problem', message);
      say(message, true);
    } else if (outcome.reason === 'unavailable') {
      setChoosing(true);
    } else if (outcome.reason === 'failed') {
      const message = "I couldn't hear that. Try again.";
      add('problem', message);
      say(message, true);
    } else {
      const message = "I didn't catch that. Tap and try again.";
      add('problem', message);
      say(message, true); // spoken, because while riding nothing is shown
    }
    sayWaitingLine();
  };

  const announce = (text: string) => {
    waitingLine.current = text; // only the latest is worth saying
    sayWaitingLine(); // now if nothing is in progress, otherwise when it is over
  };

  const dismiss = () => {
    ear.current?.cancel();
    hush();
    answer(false);
    setChoosing(false);
    setActive(false);
  };

  return (
    <AgentContext
      value={{
        talk,
        listening,
        transcribing,
        choosing,
        heard,
        active,
        dismiss,
        current: transcript.filter((line) => line.id >= turnFrom),
        enabled: settings.loaded && settings.agentEnabled,
        open,
        setOpen: (next) => {
          setOpenState(next);
          if (!next) answer(false); // closing the sheet declines whatever was being asked
        },
        thinking,
        transcript,
        confirming,
        answer,
        ask,
        announce,
        routedByAgentRecently: () => Date.now() - agentRoutedAt.current < AGENT_ROUTE_QUIET_MS,
        reset,
      }}>
      {children}
      {recording && (
        <VoiceRecorder
          address={settings.agentUrl}
          token={settings.agentToken}
          controlRef={ear}
          onStopped={() => setTranscribing(true)}
          onDone={heardSomething}
        />
      )}
    </AgentContext>
  );
}

export function useAgent() {
  const value = use(AgentContext);
  if (!value) throw new Error('useAgent must be used inside <AgentProvider>');
  return value;
}

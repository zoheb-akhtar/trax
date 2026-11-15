import { useEffect, useRef } from 'react';

import { oneLine } from '@/agent/agent';
import { useAgent } from '@/agent/agent-provider';
import { makeClient } from '@/agent/client';
import { rideFacts, routeFacts, worthDebrief } from '@/agent/moments';
import { BRIEFING_PROMPT, DEBRIEF_PROMPT } from '@/agent/prompt';
import { useRideHistory } from '@/history/history-provider';
import { useNav } from '@/nav/nav-provider';
import { useSettings } from '@/settings/settings-provider';

/** Wait this long for street data before briefing with what is known. */
const BRIEFING_WAIT_MS = 12000;
/** Only a ride that ended this recently is debriefed, so old rides aren't read out at launch. */
const JUST_ENDED_MS = 20000;

/**
 * The moments when Trax speaks up without being asked: a one-sentence briefing when a route
 * is planned, and a one-sentence debrief when a ride ends. Each is one request to the AI
 * agent; if it fails, nothing is said. Renders nothing.
 */
export function CoPilotMoments() {
  const { loaded, agentEnabled, agentUrl, agentToken } = useSettings();
  const { announce, routedByAgentRecently } = useAgent();
  const trip = useNav();
  const { rides } = useRideHistory();
  const on = loaded && agentEnabled && agentUrl.trim() !== '';

  // Effects below run later than the render that scheduled them, so they read through refs.
  const latest = useRef({ trip, rides, announce, routedByAgentRecently, agentUrl, agentToken });
  useEffect(() => {
    latest.current = { trip, rides, announce, routedByAgentRecently, agentUrl, agentToken };
  });

  // ---- Route briefing: once per destination, when its route is ready -------------------
  const briefed = useRef(new Set<string>());
  const { destination, status, extras, bikeLanes } = trip;
  const routeKey =
    status === 'ready' && destination
      ? `${destination.lat.toFixed(5)},${destination.lon.toFixed(5)},${bikeLanes}`
      : null;
  useEffect(() => {
    if (!on || !routeKey || briefed.current.has(routeKey)) return;
    const brief = async () => {
      if (briefed.current.has(routeKey)) return;
      briefed.current.add(routeKey);
      const now = latest.current;
      // The agent planned this route itself and has just described it.
      if (now.routedByAgentRecently()) return;
      const facts = routeFacts(now.trip);
      if (!facts) return;
      try {
        const line = await oneLine(makeClient(now.agentUrl, now.agentToken), BRIEFING_PROMPT, facts);
        // Say it only if this is still the route on screen.
        if (line && latest.current.trip.destination === now.trip.destination) {
          latest.current.announce(line);
        }
      } catch {
        // No briefing this time.
      }
    };
    // Street data makes the briefing worth hearing; give it a moment to arrive.
    if (extras !== 'loading') {
      brief();
      return;
    }
    const timer = setTimeout(brief, BRIEFING_WAIT_MS);
    return () => clearTimeout(timer);
  }, [on, routeKey, extras]);

  // ---- Ride debrief: when the newest ride has just ended --------------------------------
  const debriefed = useRef(new Set<string>());
  const newest = rides.find((ride) => ride.endedAt != null);
  const endedId = newest?.id;
  const endedAt = newest?.endedAt ?? 0;
  useEffect(() => {
    if (!on || !endedId || debriefed.current.has(endedId)) return;
    debriefed.current.add(endedId);
    const now = latest.current;
    const ride = now.rides.find((candidate) => candidate.id === endedId);
    if (!ride || Date.now() - endedAt > JUST_ENDED_MS || !worthDebrief(ride)) return;
    (async () => {
      try {
        const facts = await rideFacts(ride, now.rides);
        const line = await oneLine(makeClient(now.agentUrl, now.agentToken), DEBRIEF_PROMPT, facts);
        if (line) latest.current.announce(line);
      } catch {
        // No debrief this time.
      }
    })();
  }, [on, endedId, endedAt]);

  return null;
}

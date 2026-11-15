import Anthropic from '@anthropic-ai/sdk';

import { BETAS, EFFORT, MAX_ROUNDS, MAX_TOKENS, MODEL } from './config';
import { ALARM_PROMPT, SYSTEM_PROMPT } from './prompt';
import { runTool, stateSnapshot, TOOLS, type AgentWorld } from './tools';

export type AgentMessage = Anthropic.Beta.BetaMessageParam;

type Turn = {
  client: Anthropic;
  /** The conversation so far. New messages are appended to this array. */
  history: AgentMessage[];
  userText: string;
  /** Returns the current state of the app; called again before each tool runs. */
  world(): AgentWorld;
  /** Called as each tool finishes, with a line to show the owner. */
  onTool?(label: string): void;
};

/**
 * One question from the owner: calls the model, runs whatever tools it asks for, and
 * repeats until it gives a spoken answer. Returns that answer.
 */
export async function runTurn({ client, history, userText, world, onTool }: Turn): Promise<string> {
  // The state snapshot rides along with the question, so most answers need no tool call.
  history.push({ role: 'user', content: `${stateSnapshot(world())}\n\nOwner: ${userText}` });

  let spoken = '';
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      betas: BETAS,
      fallbacks: 'default',
      output_config: { effort: EFFORT },
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      messages: history,
    });

    // Keep the whole reply (thinking and tool-use blocks included), not just its text.
    history.push({ role: 'assistant', content: response.content });
    spoken = response.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .trim();

    if (response.stop_reason === 'refusal') return "Sorry, I can't help with that.";
    if (response.stop_reason !== 'tool_use') break;

    const calls = response.content.filter(
      (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use',
    );
    // Every result goes back in one message, in the order the tools were asked for.
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of calls) {
      let outcome;
      try {
        outcome = await runTool(call.name, call.input, world());
      } catch (error) {
        outcome = {
          label: call.name,
          isError: true,
          content: `The tool failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        };
      }
      onTool?.(outcome.label);
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: outcome.content,
        is_error: outcome.isError,
      });
    }
    history.push({ role: 'user', content: results });
  }

  return spoken || "I couldn't finish that. Try asking again.";
}

/** One sentence describing a picture taken as the alarm went off. Throws if the call fails. */
export async function describeAlarmPicture(client: Anthropic, jpegBase64: string) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    betas: BETAS,
    fallbacks: 'default',
    output_config: { effort: EFFORT },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegBase64 } },
          { type: 'text', text: ALARM_PROMPT },
        ],
      },
    ],
  });
  if (response.stop_reason === 'refusal') return null;
  const text = response.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
    .trim();
  return text || null;
}

/**
 * True when the service rejected the request itself. With an earlier conversation attached,
 * the usual cause is that conversation no longer being valid (for example the tool list changed
 * after an app update), so the caller starts a fresh one and asks again.
 */
export function wasRejected(error: unknown) {
  return error instanceof Anthropic.BadRequestError;
}

/** A short explanation of a failed request, suitable for reading aloud. */
export function explainError(error: unknown) {
  if (error instanceof Anthropic.APIConnectionError) {
    return "I can't reach the Velo agent server. Check its address in the Device tab.";
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return 'The agent server rejected the request. Check the proxy token, or the API key on the server.';
  }
  if (error instanceof Anthropic.RateLimitError) return "I'm being rate limited. Try again in a moment.";
  if (error instanceof Anthropic.APIError) {
    return error.status === 503
      ? 'The agent server has no API key set.'
      : `The AI service returned an error (${error.status ?? 'unknown'}).`;
  }
  return 'Something went wrong talking to the AI service.';
}

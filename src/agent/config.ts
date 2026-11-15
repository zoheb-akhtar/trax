/**
 * Settings for Trax's AI agent. To trade answer quality for speed and cost, change MODEL to
 * 'claude-haiku-5-5' here; nothing else needs to change.
 */
export const MODEL = 'claude-opus-5-5';
/** Low effort keeps spoken answers quick. Thinking is always on for this model. */
export const EFFORT = 'low' as const;
/**
 * Replies are a sentence or two, spoken aloud, but this ceiling also covers the model's
 * thinking, so it is set well above that. It is a limit, not a cost.
 */
export const MAX_TOKENS = 8000;
/** The most model calls one question may take (each round of tool use is one call). */
export const MAX_ROUNDS = 5;
/** If a safety check declines a request, the API retries it on a fallback model. */
export const BETAS = ['server-side-fallback-2026-07-01'];
/** A conversation is started afresh after this many messages, or this long idle. */
export const MAX_HISTORY_MESSAGES = 24;
export const IDLE_RESET_MS = 5 * 60 * 1000;
/** Long enough for a question with a camera picture; the proxy itself gives up at 120 s. */
export const REQUEST_TIMEOUT_MS = 60000;

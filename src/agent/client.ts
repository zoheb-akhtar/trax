import Anthropic from '@anthropic-ai/sdk';

import { REQUEST_TIMEOUT_MS } from './config';

/** "192.168.1.20:8787" -> "http://192.168.1.20:8787" */
export function proxyUrl(address: string) {
  const trimmed = address.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/**
 * A client that talks to the Trax agent proxy, which holds the real API key.
 *
 * `apiKey` here is only the optional proxy token (or a placeholder), never an Anthropic key,
 * which is why allowing the SDK to run inside the app is safe.
 */
export function makeClient(address: string, token: string) {
  return new Anthropic({
    baseURL: proxyUrl(address),
    apiKey: cleanToken(token) || 'trax-proxy',
    // The SDK sends the key as "Authorization: Bearer"; the agent server reads x-api-key.
    defaultHeaders: { 'x-api-key': cleanToken(token) || 'trax-proxy' },
    dangerouslyAllowBrowser: true,
    // No automatic retry: a slow request that is retried is sent, and billed, twice.
    maxRetries: 0,
    timeout: REQUEST_TIMEOUT_MS,
  });
}

/**
 * The password as typed, undoing what a phone keyboard does to it: spaces, quotes, a capital
 * first letter, and a hyphen turned into a dash. The server's passwords are lower case.
 */
export function cleanToken(token: string) {
  return token
    .replace(/[\s"'\u201c\u201d\u2018\u2019]/g, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .toLowerCase();
}

/**
 * Checks the agent server end to end, without asking the AI anything: that it can be reached,
 * that it accepts this phone's password, and that it has an API key.
 */
export async function checkAgentServer(address: string, token: string) {
  const base = proxyUrl(address);
  if (!base) return { title: 'No address', detail: 'Enter the agent server address first.' };
  let health: { key_configured?: boolean; speech?: string };
  try {
    const response = await fetch(`${base}/health`);
    health = await response.json();
  } catch {
    return {
      title: 'Can’t reach the agent server',
      detail: `Nothing answered at ${base}. Check the address, that it is running, and that the phone is on the same Wi-Fi as the laptop.`,
    };
  }
  // A request for a model the server won't forward: it answers 400 if the password was right,
  // 401 if not, and nothing is sent to the AI either way.
  let status = 0;
  try {
    const response = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': cleanToken(token) || 'trax-proxy' },
      body: JSON.stringify({ model: 'trax-check' }),
    });
    status = response.status;
  } catch {
    return { title: 'Can’t reach the agent server', detail: 'It answered once, then stopped. Try again.' };
  }
  if (status === 401) {
    return {
      title: 'Wrong password',
      detail: `The phone sent "${cleanToken(token) || '(nothing)'}". The agent server printed its password when it started (trax- and four digits). Enter it exactly, under AI agent.`,
    };
  }
  if (!health.key_configured) {
    return {
      title: 'No API key on the server',
      detail: 'Restart the agent server in a terminal where ANTHROPIC_API_KEY is set.',
    };
  }
  return {
    title: 'Agent server OK',
    detail: `Reached it, the password works, and it has an API key. Speech to text: ${health.speech ?? 'unknown'}.`,
  };
}

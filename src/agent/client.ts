import Anthropic from '@anthropic-ai/sdk';

import { REQUEST_TIMEOUT_MS } from './config';

/** "192.168.1.20:8787" -> "http://192.168.1.20:8787" */
export function proxyUrl(address: string) {
  const trimmed = address.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/**
 * A client that talks to the Velo agent proxy, which holds the real API key.
 *
 * `apiKey` here is only the optional proxy token (or a placeholder), never an Anthropic key,
 * which is why allowing the SDK to run inside the app is safe.
 */
export function makeClient(address: string, token: string) {
  return new Anthropic({
    baseURL: proxyUrl(address),
    apiKey: token.trim() || 'velo-proxy',
    dangerouslyAllowBrowser: true,
    // No automatic retry: a slow request that is retried is sent, and billed, twice.
    maxRetries: 0,
    timeout: REQUEST_TIMEOUT_MS,
  });
}

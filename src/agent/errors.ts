import { config } from '../config.ts';

export interface ErrorInfo {
  message: string; // for the user
  short: string; // for notices and traces: "<model> is rate-limited"
  retryable: boolean; // could another model, or a later attempt, succeed?
  cooldownMs?: number; // how long to rest this model before trying it first again
}

/** Classify a provider error: what to tell the user, whether another model could do better, and how long to rest this one. */
export function describeError(err: unknown): ErrorInfo {
  let e = err as { statusCode?: number; lastError?: unknown; cause?: unknown; message?: string };
  // The SDK wraps errors (RetryError.lastError, .cause); find the one with a status code.
  for (let i = 0; i < 3 && e && !e.statusCode && (e.lastError || e.cause); i++) e = (e.lastError ?? e.cause) as typeof e;
  const status = e?.statusCode;

  if (status === 429) {
    // Providers say how long to wait: Gemini puts it in the body ("retryDelay": "55840s" when a
    // *daily* free quota is used up), others use a retry-after header. Default: one minute.
    const ex = e as { responseBody?: string; data?: unknown; responseHeaders?: Record<string, string> };
    const body = `${ex.responseBody ?? ''} ${JSON.stringify(ex.data ?? '')}`;
    const delayS = Number(body.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/)?.[1] ?? ex.responseHeaders?.['retry-after'] ?? NaN);
    const daily = /PerDay/i.test(body);
    return {
      short: daily ? 'has used up its daily free quota' : 'is rate-limited',
      retryable: true,
      cooldownMs: Number.isFinite(delayS) ? Math.min(Math.max(delayS * 1000, 5_000), 24 * 3_600_000) : 60_000,
      message: daily
        ? 'The model’s daily free quota is used up. It resets within 24 hours; meanwhile set LLM_MODEL in .env to another model (e.g. gemini-3.5-flash-lite) or add a second provider key.'
        : 'The model provider is rate-limiting requests (free tiers allow only a few per minute). Wait a minute and try again.',
    };
  }
  if (status === 401 || status === 403) return { short: 'rejected the API key', retryable: true, cooldownMs: 10 * 60_000, message: 'The model API key was rejected. Check it in .env.' };
  if (status === 404) return { short: 'is not available for this key', retryable: true, cooldownMs: 10 * 60_000, message: `The model "${config.mainModel}" was not found for this API key. Set LLM_MODEL in .env to a model you have access to.` };
  if (status === 503) return { short: 'is overloaded', retryable: true, cooldownMs: 15_000, message: 'The model provider is overloaded right now. Please try again in a minute.' };
  if (status && status >= 500) return { short: 'had a server error', retryable: true, cooldownMs: 10_000, message: 'The model provider had a temporary error. Please try again.' };
  if (!status && /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|network|socket/i.test(e?.message ?? '')) {
    return { short: 'could not be reached', retryable: true, message: 'Could not reach the model provider. Check your internet connection.' };
  }
  return { short: 'failed', retryable: false, message: `Something went wrong: ${e?.message ?? 'unknown error'}` };
}

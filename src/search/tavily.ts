/**
 * Thin Tavily client (plain fetch, no SDK). Tavily was chosen because it is
 * built for agents: it returns the *relevant passages* of each page, not just
 * a two-line snippet, and supports publish-date and domain filters.
 * Anything else that implements `SearchProvider` can be swapped in.
 */

export interface SearchParams {
  query: string;
  mode: 'web' | 'news';
  since?: string; // YYYY-MM-DD
  domains?: string[];
  maxResults: number;
  depth: 'basic' | 'advanced';
}

export interface RawResult {
  title: string;
  url: string;
  content: string;
  published?: string;
  score: number;
}

export type SearchProvider = (p: SearchParams, signal: AbortSignal) => Promise<RawResult[]>;

export class SearchError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

const ATTEMPT_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;

/**
 * Caps concurrent requests. Ten parallel searches from one turn would trip
 * free-tier rate limits; four at a time finishes almost as fast and doesn't.
 */
export function limitConcurrency(provider: SearchProvider, max: number): SearchProvider {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (p, signal) => {
    if (active < max) active++;
    else {
      // Wait for a finishing request to hand its slot over directly, so a
      // newcomer can't slip in between and exceed the cap.
      await new Promise<void>((resolve, reject) => {
        const go = () => (signal.removeEventListener('abort', cancel), resolve());
        const cancel = () => {
          const i = waiting.indexOf(go);
          if (i >= 0) waiting.splice(i, 1);
          reject(signal.reason);
        };
        waiting.push(go);
        signal.addEventListener('abort', cancel, { once: true });
      });
    }
    try {
      return await provider(p, signal);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

export function createTavily(apiKey: string, maxConcurrent = 4): SearchProvider {
  return limitConcurrency(tavilySearch(apiKey), maxConcurrent);
}

function tavilySearch(apiKey: string): SearchProvider {
  return async function search(p, signal) {
    const body: Record<string, unknown> = {
      query: p.query.slice(0, 400), // Tavily rejects very long queries
      topic: p.mode === 'news' ? 'news' : 'general',
      search_depth: p.depth,
      max_results: p.maxResults,
      include_answer: false,
      include_raw_content: false,
    };
    if (p.depth === 'advanced') body.chunks_per_source = 3;
    if (p.since) body.start_date = p.since;
    if (p.domains?.length) body.include_domains = p.domains;

    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.any([signal, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)]),
        });
        if (!res.ok) {
          const detail = (await res.text().catch(() => '')).slice(0, 200);
          if (res.status === 401 || res.status === 403) throw new SearchError('Search API key was rejected (check TAVILY_API_KEY).', false);
          if (res.status === 432 || res.status === 433) throw new SearchError('Search quota for this API key is used up.', false);
          if (res.status === 400) throw new SearchError(`Search request was rejected: ${detail}`, false);
          throw new SearchError(`Search provider returned HTTP ${res.status}.`, res.status === 429 || res.status >= 500);
        }
        const json = (await res.json()) as { results?: Array<Record<string, unknown>> };
        return (json.results ?? []).map((r) => ({
          title: String(r.title ?? ''),
          url: String(r.url ?? ''),
          content: String(r.content ?? ''),
          published: typeof r.published_date === 'string' ? r.published_date : undefined,
          score: Number(r.score ?? 0),
        }));
      } catch (err) {
        if (signal.aborted) throw err; // user pressed stop: don't retry
        lastErr = err;
        const retryable = err instanceof SearchError ? err.retryable : true; // network errors and timeouts
        if (!retryable || attempt === MAX_ATTEMPTS) break;
        await sleep(400 * 2 ** (attempt - 1) + Math.random() * 250, signal);
      }
    }
    if (lastErr instanceof SearchError) throw lastErr;
    const name = (lastErr as Error)?.name;
    throw new SearchError(name === 'TimeoutError' ? 'Search timed out.' : `Search failed: ${(lastErr as Error)?.message ?? 'unknown error'}`, false);
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
}

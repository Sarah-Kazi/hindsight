import { config, configProblems } from '../src/config.ts';
import { getModels } from '../src/llm.ts';
import { Store } from '../src/memory/store.ts';
import { Recall } from '../src/memory/recall.ts';
import { createTavily } from '../src/search/tavily.ts';
import { Agent, type TurnEvent } from '../src/agent/turn.ts';
import { addDays, localDay, weekdayOf } from '../src/time.ts';

/** Shared by `npm run eval` and `npm run seed`: real models, real search, controllable clock. */

export const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function makeAgent(dataDir: string) {
  const problems = configProblems();
  const models = getModels();
  if (!models || !config.tavilyKey) {
    console.error('Live runs need a model key and TAVILY_API_KEY:\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
  const store = new Store(dataDir);
  const agent = new Agent(store, new Recall(store), models, createTavily(config.tavilyKey));
  return { store, agent, models };
}

/** 11:00 local time on the most recent past <weekday> (0 = Sunday). */
export function lastWeekdayAt11(weekday: number, from = new Date()): Date {
  const today = localDay(from, TZ);
  const back = (weekdayOf(today) - weekday + 7) % 7 || 7;
  return new Date(`${addDays(today, -back)}T11:00:00`);
}

export interface TurnRecord {
  text: string;
  answer: string;
  threadId?: string;
  searches: Array<{ query: string; since?: string; mode: string }>;
  recalled: number;
  noRecordFor: string[];
  firstTokenMs: number | null;
  totalMs: number;
  error?: string;
}

export async function ask(agent: Agent, text: string, opts: { now?: Date; threadId?: string; seeded?: boolean; quiet?: boolean } = {}): Promise<TurnRecord> {
  const started = Date.now();
  const rec: TurnRecord = { text, answer: '', searches: [], recalled: 0, noRecordFor: [], firstTokenMs: null, totalMs: 0 };
  const emit = (e: TurnEvent) => {
    if (e.type === 'meta') rec.threadId = e.threadId;
    if (e.type === 'memory') ((rec.recalled = e.recalled.length), (rec.noRecordFor = e.noRecordFor));
    if (e.type === 'search-start') {
      rec.searches.push({ query: e.query, since: e.since, mode: e.mode });
      if (!opts.quiet) console.log(`    🔎 ${e.query}${e.since ? `  [since ${e.since}]` : ''}${e.domains?.length ? `  [${e.domains.join(',')}]` : ''}`);
    }
    if (e.type === 'delta') {
      rec.firstTokenMs ??= Date.now() - started;
      rec.answer += e.text;
    }
    if (e.type === 'error') rec.error = e.message;
    if (e.type === 'retry') {
      rec.answer = e.text;
      if (e.message && !opts.quiet) console.log(`    ↻ ${e.message}`);
    }
  };
  await agent.turn({ text, tz: TZ, now: opts.now, threadId: opts.threadId, seeded: opts.seeded, signal: new AbortController().signal, emit });
  rec.totalMs = Date.now() - started;
  return rec;
}

export const SEED_CONVERSATIONS = [
  {
    weekday: 2, // Tuesday
    text: "I'm picking managed Postgres hosting for a small SaaS (~20 GB data). Compare Neon, Supabase, AWS RDS and Render on price for that size.",
  },
  {
    weekday: 1, // Monday
    text: "We're a 20-person sales team choosing a CRM. Shortlist the 5 best options for us with per-seat pricing.",
  },
];

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { Store } from '../src/memory/store.ts';
import { Recall } from '../src/memory/recall.ts';
import { Agent, type TurnEvent } from '../src/agent/turn.ts';
import type { Models } from '../src/llm.ts';
import type { SearchProvider } from '../src/search/tavily.ts';

/**
 * End-to-end turn with a scripted model and a fake search provider:
 * pre-flight → parallel tool calls → streamed cited answer → saved → digested →
 * recalled by date from a different chat a week later.
 */

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
const finish = (unified: 'stop' | 'tool-calls') => ({ type: 'finish' as const, usage, finishReason: { unified, raw: unified } });

function text(id: string, s: string) {
  return [{ type: 'text-start' as const, id }, { type: 'text-delta' as const, id, delta: s }, { type: 'text-end' as const, id }];
}

function scriptedModel(steps: Array<Array<Record<string, unknown>>>) {
  let i = 0;
  const systemPrompts: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (opts) => {
      systemPrompts.push(opts.prompt.filter((m) => m.role === 'system').map((m) => m.content).join('\n'));
      const parts = steps[Math.min(i++, steps.length - 1)]!;
      return { stream: convertArrayToReadableStream([{ type: 'stream-start', warnings: [] }, ...parts] as never) };
    },
    doGenerate: async () => ({
      content: [{
        type: 'text',
        text: JSON.stringify({
          title: 'Postgres hosting pricing',
          summary: 'Compared Neon and Supabase pricing.',
          topics: ['postgres hosting', 'database pricing'],
          entities: ['Neon', 'Supabase'],
          claims: [{ entity: 'Neon', attribute: 'Launch plan price', value: '$19/month', source: 1 }],
        }),
      }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
      warnings: [],
    }),
  });
  return { model, systemPrompts, calls: () => i };
}

const fakeSearch: SearchProvider = async (p) => {
  const vendor = p.query.toLowerCase().includes('neon') ? 'neon.com' : 'supabase.com';
  return [{ title: `${vendor} pricing`, url: `https://${vendor}/pricing`, content: `Pricing for ${vendor}.`, score: 0.9 }];
};

test('full turn: parallel searches, cited answer, digest, then date-based recall from another chat', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'hindsight-agent-')));
  const recall = new Recall(store);

  // ── Turn 1, on Tue 3 Nov ──
  const s1 = scriptedModel([
    [
      { type: 'tool-call', toolCallId: 'c1', toolName: 'web_search', input: JSON.stringify({ query: 'Neon pricing', domains: ['neon.com'] }) },
      { type: 'tool-call', toolCallId: 'c2', toolName: 'web_search', input: JSON.stringify({ query: 'Supabase pricing', domains: ['supabase.com'] }) },
      finish('tool-calls'),
    ],
    [...text('t1', 'Neon Launch is $19/month [1]; Supabase Pro is $25/month [2].'), finish('stop')],
  ]);
  const models: Models = { provider: 'gemini', main: s1.model, fast: s1.model, mainId: 'mock', fastId: 'mock' };
  const agent1 = new Agent(store, recall, models, fakeSearch);
  const events: TurnEvent[] = [];
  const answer = await agent1.turn({
    text: 'Compare Postgres hosting: Neon vs Supabase pricing',
    tz: 'UTC',
    now: new Date('2026-11-03T10:00:00Z'),
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
  });
  await agent1.idle();

  assert.ok(answer);
  assert.equal(answer.status, 'complete');
  assert.equal(answer.content, 'Neon Launch is $19/month [1]; Supabase Pro is $25/month [2].');
  assert.deepEqual(answer.sources?.map((s) => s.n).sort(), [1, 2]);
  assert.equal(answer.searches?.length, 2);
  assert.equal(events.filter((e) => e.type === 'search-start').length, 2);
  assert.ok(events.some((e) => e.type === 'done'));
  // First-ever turn: the prompt must say there is no history.
  assert.match(s1.systemPrompts[0]!, /NO record of any earlier conversation/);
  // Digest stored and thread renamed from it.
  const saved = store.getMessage(answer.id)!;
  assert.equal(saved.digest?.by, 'llm');
  assert.equal(store.getThread(answer.threadId)!.title, 'Postgres hosting pricing');

  // ── Turn 2, new chat, on Tue 10 Nov ──
  const s2 = scriptedModel([[...text('t2', 'On Tue 3 Nov I said Neon Launch was $19/month.'), finish('stop')]]);
  const agent2 = new Agent(store, recall, { ...models, main: s2.model, fast: s2.model }, fakeSearch);
  const events2: TurnEvent[] = [];
  await agent2.turn({
    text: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
    tz: 'UTC',
    now: new Date('2026-11-10T15:00:00Z'),
    signal: new AbortController().signal,
    emit: (e) => events2.push(e),
  });
  const sys = s2.systemPrompts[0]!;
  assert.match(sys, /"Last Tuesday" → Tue 3 Nov 2026/);
  assert.match(sys, /since="2026-11-03"/);
  assert.match(sys, /User asked: Compare Postgres hosting/);
  assert.match(sys, /Neon · Launch plan price: \$19\/month \(source: https:\/\/neon\.com\/pricing\)/);
  // "Has pricing changed?" about a recalled answer → code writes the search plan.
  assert.match(sys, /re-checks an earlier answer/);
  assert.match(sys, /From your answer on Tue 3 Nov 2026: items = Neon/);
  assert.match(sys, /CURRENT STATE: .* NO "since"/);
  assert.match(sys, /since="2026-11-03"/);
  // Old citation numbers would point at nothing in the new answer: shown as domains instead.
  assert.match(sys, /You answered: Neon Launch is \$19\/month \(source: neon\.com\); Supabase Pro is \$25\/month \(source: supabase\.com\)\./);
  const mem = events2.find((e) => e.type === 'memory');
  assert.ok(mem && mem.type === 'memory' && mem.recalled.length === 1);
});

test('a model that ends on a tool step still produces an answer (tools-off retry)', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'hindsight-agent-')));
  const s = scriptedModel([
    [{ type: 'tool-call', toolCallId: 'c1', toolName: 'web_search', input: JSON.stringify({ query: 'Neon pricing' }) }, finish('tool-calls')],
    [finish('stop')], // empty answer after the tool result
    [...text('t', 'Neon Launch is $19/month [1].'), finish('stop')],
  ]);
  const agent = new Agent(store, new Recall(store), { provider: 'gemini', main: s.model, fast: s.model, mainId: 'm', fastId: 'm' }, fakeSearch);
  const msg = await agent.turn({ text: 'Neon price?', tz: 'UTC', signal: new AbortController().signal, emit: () => {} });
  assert.equal(msg?.content, 'Neon Launch is $19/month [1].');
});

test('search failures reach the model as text, not as a crash', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'hindsight-agent-')));
  const s = scriptedModel([
    [{ type: 'tool-call', toolCallId: 'c1', toolName: 'web_search', input: JSON.stringify({ query: 'x' }) }, finish('tool-calls')],
    [...text('t', 'I could not search just now.'), finish('stop')],
  ]);
  const failing: SearchProvider = async () => {
    throw new Error('Search timed out.');
  };
  const events: TurnEvent[] = [];
  const agent = new Agent(store, new Recall(store), { provider: 'gemini', main: s.model, fast: s.model, mainId: 'm', fastId: 'm' }, failing);
  const msg = await agent.turn({ text: 'latest news?', tz: 'UTC', signal: new AbortController().signal, emit: (e) => events.push(e) });
  assert.equal(msg?.status, 'complete');
  const end = events.find((e) => e.type === 'search-end');
  assert.ok(end && end.type === 'search-end' && end.error === 'Search timed out.');
});

test('stop mid-answer saves the partial answer as aborted', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'hindsight-agent-')));
  const ctrl = new AbortController();
  const model = new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream({
        async start(c) {
          c.enqueue({ type: 'stream-start', warnings: [] });
          c.enqueue({ type: 'text-start', id: 't' });
          c.enqueue({ type: 'text-delta', id: 't', delta: 'Partial answer' });
          await new Promise((r) => setTimeout(r, 30));
          ctrl.abort();
          abortSignal?.throwIfAborted();
        },
      }),
    }),
  });
  const agent = new Agent(store, new Recall(store), { provider: 'gemini', main: model, fast: model, mainId: 'm', fastId: 'm' }, fakeSearch);
  const msg = await agent.turn({ text: 'tell me a story', tz: 'UTC', signal: ctrl.signal, emit: () => {} });
  assert.equal(msg?.status, 'aborted');
  assert.equal(msg?.content, 'Partial answer');
});

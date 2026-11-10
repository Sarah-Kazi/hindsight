import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/memory/store.ts';
import { Recall } from '../src/memory/recall.ts';
import { localDay } from '../src/time.ts';
import { buildHistory } from '../src/agent/history.ts';

const NOW = new Date('2026-11-10T15:00:00Z');

function freshStore() {
  return new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'hindsight-test-')));
}

function addExchange(store: Store, iso: string, question: string, answer: string, extra: { title?: string; entities?: string[] } = {}) {
  const at = new Date(iso);
  const t = store.createThread(at, extra.title ?? question.slice(0, 30));
  store.addMessage({ threadId: t.id, role: 'user', content: question, createdAt: at.toISOString(), localDay: localDay(at, 'UTC'), tz: 'UTC' });
  const a = store.addMessage({
    threadId: t.id, role: 'assistant', content: answer, createdAt: new Date(at.getTime() + 5000).toISOString(), localDay: localDay(at, 'UTC'), tz: 'UTC', status: 'complete',
    sources: [{ n: 1, url: 'https://neon.com/pricing', title: 'Neon pricing', domain: 'neon.com', retrievedAt: at.toISOString() }],
  });
  if (extra.entities) {
    store.updateMessage(a.id, { digest: { title: extra.title ?? 'x', summary: question, topics: ['postgres hosting', 'database'], entities: extra.entities, claims: [{ entity: 'Neon', attribute: 'Launch plan price', value: '$19/month', source: 1 }], by: 'llm' } });
  }
  return { thread: t, assistant: a };
}

test('empty memory says so explicitly, including the day the user named', () => {
  const r = new Recall(freshStore()).build({ text: 'What did I ask you on 3 November?', now: NOW, tz: 'UTC', excludeIds: new Set() });
  assert.match(r.block, /NO record of any earlier conversation/);
  assert.match(r.block, /Tue 3 Nov 2026/);
  assert.deepEqual(r.noRecordFor, ['Tue 3 Nov 2026']);
});

test('date reference recalls that day in full, with claims and sources', () => {
  const store = freshStore();
  addExchange(store, '2026-11-03T10:00:00Z', 'Compare Postgres hosting: Neon vs Supabase', 'Neon Launch is $19/month [1].', { title: 'Postgres hosting', entities: ['Neon', 'Supabase'] });
  addExchange(store, '2026-11-05T10:00:00Z', 'Best pizza dough hydration?', 'About 65%.');
  const r = new Recall(store).build({ text: 'What did I ask you on 3 November? Is it still correct?', now: NOW, tz: 'UTC', excludeIds: new Set() });
  assert.equal(r.recalled.length, 1);
  assert.equal(r.recalled[0]!.day, '2026-11-03');
  assert.match(r.block, /User asked: Compare Postgres hosting/);
  assert.match(r.block, /Neon · Launch plan price: \$19\/month \(source: https:\/\/neon\.com\/pricing\)/);
  assert.equal(r.noRecordFor.length, 0);
});

test('a day with no record says so and lists the nearest days that have one', () => {
  const store = freshStore();
  addExchange(store, '2026-11-05T10:00:00Z', 'Best pizza dough hydration?', 'About 65%.');
  const r = new Recall(store).build({ text: 'On Monday we shortlisted 5 CRM tools. Any pricing changes since?', now: NOW, tz: 'UTC', excludeIds: new Set() });
  assert.deepEqual(r.noRecordFor, ['Mon 9 Nov 2026']);
  assert.match(r.block, /<no_record phrase="On Monday"/);
  assert.match(r.block, /Thu 5 Nov 2026/);
});

test('topic match finds a past conversation without a date', () => {
  const store = freshStore();
  addExchange(store, '2026-11-03T10:00:00Z', 'Compare Postgres hosting: Neon vs Supabase', 'Neon Launch is $19/month [1].', { title: 'Postgres hosting', entities: ['Neon', 'Supabase'] });
  addExchange(store, '2026-11-05T10:00:00Z', 'Best pizza dough hydration?', 'About 65%.');
  const r = new Recall(store).build({ text: 'Remember the postgres options you gave me? Has anything changed?', now: NOW, tz: 'UTC', excludeIds: new Set() });
  assert.equal(r.recalled[0]?.title, 'Postgres hosting');
});

test('a match that is already in the current chat is not reported as missing', () => {
  const store = freshStore();
  const { assistant } = addExchange(store, '2026-11-10T09:00:00Z', 'Neon pricing?', 'Neon Launch is $19/month.');
  const r = new Recall(store).build({ text: 'what did I ask you this morning?', now: NOW, tz: 'UTC', excludeIds: new Set([assistant.id]) });
  assert.equal(r.noRecordFor.length, 0);
  assert.match(r.block, /already visible above/);
});

test('history keeps roles alternating when a turn failed', () => {
  const store = freshStore();
  const t = store.createThread(NOW);
  const base = { threadId: t.id, localDay: '2026-11-10', tz: 'UTC' };
  store.addMessage({ ...base, role: 'user', content: 'first', createdAt: '2026-11-10T10:00:00Z' });
  store.addMessage({ ...base, role: 'user', content: 'second', createdAt: '2026-11-10T10:01:00Z' });
  store.addMessage({ ...base, role: 'assistant', content: 'answer', createdAt: '2026-11-10T10:02:00Z', status: 'complete' });
  const { messages } = buildHistory(store.threadMessages(t.id), 10_000);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
});

test('history drops the oldest turns when over budget, and starts with a user turn', () => {
  const store = freshStore();
  const t = store.createThread(NOW);
  const base = { threadId: t.id, localDay: '2026-11-10', tz: 'UTC' };
  for (let i = 0; i < 6; i++) {
    store.addMessage({ ...base, role: 'user', content: `q${i} ${'x'.repeat(200)}`, createdAt: `2026-11-10T10:0${i}:00Z` });
    store.addMessage({ ...base, role: 'assistant', content: `a${i} ${'y'.repeat(200)}`, createdAt: `2026-11-10T10:0${i}:30Z`, status: 'complete' });
  }
  const { messages, includedAssistantIds } = buildHistory(store.threadMessages(t.id), 1000);
  assert.equal(messages[0]!.role, 'user');
  assert.ok(messages.length < 12);
  assert.equal(includedAssistantIds.size, messages.filter((m) => m.role === 'assistant').length);
});

test('store survives a corrupt file by backing it up', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hindsight-test-'));
  fs.writeFileSync(path.join(dir, 'store.json'), '{not json');
  const s = new Store(dir);
  assert.equal(s.listThreads().length, 0);
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('corrupt')));
});

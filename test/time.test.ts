import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDay, resolveTemporalRefs, startOfWeek } from '../src/time.ts';

// Tuesday 10 Nov 2026, 15:00 UTC.
const TUE = new Date('2026-11-10T15:00:00Z');
const one = (text: string, now = TUE, tz = 'UTC') => {
  const refs = resolveTemporalRefs(text, now, tz);
  assert.equal(refs.length, 1, `expected one ref in "${text}", got ${JSON.stringify(refs)}`);
  return refs[0]!;
};

test('examples from the brief', () => {
  assert.deepEqual(one('On Monday we shortlisted 5 CRM tools for a 20-person sales team.').primary, { from: '2026-11-09', to: '2026-11-09' });
  assert.deepEqual(one('What did I ask you on 3 November? Is your answer still correct today?').primary, { from: '2026-11-03', to: '2026-11-03' });
  assert.deepEqual(one('Last Tuesday I asked you about Postgres hosting.').primary, { from: '2026-11-03', to: '2026-11-03' });
  // Said on a Tuesday, "last Tuesday" is unambiguous: never today.
  assert.deepEqual(one('Last Tuesday I asked you about Postgres hosting.').alternatives, []);
});

test('bare "today" means now, but "earlier today" points at the past', () => {
  assert.equal(resolveTemporalRefs('Is that still true today?', TUE, 'UTC').length, 0);
  assert.deepEqual(one('what did I ask earlier today?').primary, { from: '2026-11-10', to: '2026-11-10' });
  assert.deepEqual(one('the thing from this morning').primary, { from: '2026-11-10', to: '2026-11-10' });
});

test('numbers that are not dates are ignored', () => {
  assert.equal(resolveTemporalRefs('Shortlist 5 CRM tools for a 20-person team, under $50/seat', TUE, 'UTC').length, 0);
});

test('"last <weekday>" is ambiguous mid-week and offers both readings', () => {
  const wed = new Date('2026-11-11T12:00:00Z');
  const r = one('last Tuesday', wed);
  assert.deepEqual(r.primary, { from: '2026-11-10', to: '2026-11-10' }); // yesterday
  assert.deepEqual(r.alternatives, [{ from: '2026-11-03', to: '2026-11-03' }]); // Tuesday of last week
});

test('bare weekday equal to today means a week ago, with today as alternative', () => {
  const r = one('on Tuesday');
  assert.deepEqual(r.primary, { from: '2026-11-03', to: '2026-11-03' });
  assert.deepEqual(r.alternatives, [{ from: '2026-11-10', to: '2026-11-10' }]);
});

test('a year-less date ahead of today means last year', () => {
  assert.deepEqual(one('what did we discuss on December 12').primary, { from: '2025-12-12', to: '2025-12-12' });
});

test('spans are ranges, not points', () => {
  assert.deepEqual(one('what did we talk about last week?').primary, { from: '2026-11-02', to: '2026-11-08' });
  assert.deepEqual(one('anything this week').primary, { from: '2026-11-09', to: '2026-11-10' });
  assert.deepEqual(one('last month').primary, { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(one('in the past 3 days').primary, { from: '2026-11-07', to: '2026-11-10' });
  assert.deepEqual(one('back in October').primary, { from: '2026-10-01', to: '2026-10-31' });
});

test('"a week ago" gets ±1 day of slack', () => {
  const r = one('a week ago I asked about pricing');
  assert.deepEqual(r.primary, { from: '2026-11-03', to: '2026-11-03' });
  assert.deepEqual(r.alternatives, [{ from: '2026-11-02', to: '2026-11-04' }]);
});

test('uses the user time zone, not UTC', () => {
  // 01:30 on Wed 11 Nov in Kolkata is still Tue 10 Nov in UTC.
  const late = new Date('2026-11-10T20:00:00Z');
  assert.equal(localDay(late, 'Asia/Kolkata'), '2026-11-11');
  assert.deepEqual(one('yesterday', late, 'Asia/Kolkata').primary, { from: '2026-11-10', to: '2026-11-10' });
  assert.deepEqual(one('yesterday', late, 'America/Los_Angeles').primary, { from: '2026-11-09', to: '2026-11-09' });
});

test('future references are flagged', () => {
  assert.equal(one('next Friday').future, true);
});

test('week starts on Monday', () => {
  assert.equal(startOfWeek('2026-11-10'), '2026-11-09');
  assert.equal(startOfWeek('2026-11-15'), '2026-11-09'); // Sunday
});

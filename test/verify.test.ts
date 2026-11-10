import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numbersIn, verifyCitations } from '../src/agent/verify.ts';

const sources = new Map([
  [1, 'Neon pricing. Launch plan: $19 per month, includes 10 GB storage. Scale: $69/month.'],
  [2, 'Supabase Pro costs $25.00 per month per project with 8 GB database.'],
]);

test('figures present in the cited source pass', () => {
  const v = verifyCitations('Neon Launch is $19/month with 10 GB [1]. Supabase Pro is $25 [2].', sources);
  assert.equal(v.checked, 3);
  assert.deepEqual(v.unsupported, []);
});

test('a figure missing from its cited source is flagged', () => {
  const v = verifyCitations('Supabase Pro is $30/month [2].', sources);
  assert.equal(v.unsupported.length, 1);
  assert.equal(v.unsupported[0]!.value, '$30');
  assert.deepEqual(v.unsupported[0]!.cites, [2]);
});

test('citing the wrong source is caught', () => {
  const v = verifyCitations('Neon Scale costs $69/month [2].', sources);
  assert.equal(v.unsupported.length, 1);
});

test('"then" values from memory are allowed; table cells are checked separately', () => {
  const table = '| Item | Then (3 Nov) | Now |\n|---|---|---|\n| Supabase | $20/month | $25/month [2] |';
  assert.deepEqual(verifyCitations(table, sources).unsupported, []); // $20 is in an uncited cell
  const prose = 'Supabase went from $20 to $25 [2].';
  assert.equal(verifyCitations(prose, sources).unsupported.length, 1);
  assert.equal(verifyCitations(prose, sources, numbersIn('On Tue 3 Nov you said Supabase Pro was $20/month')).unsupported.length, 0);
});

test('dates, years, small counts and uncited sentences are not checked', () => {
  const v = verifyCitations('As of 10 Nov 2026, there are 5 plans [1]. Pricing is $500 per seat.', sources);
  assert.equal(v.checked, 0);
});

test('number formats are normalised', () => {
  const src = new Map([[1, 'Starts at $1,500 per year, or 1.5k with discount; 20% off.']]);
  assert.deepEqual(verifyCitations('It costs $1500/year [1], about 20% less [1].', src).unsupported, []);
  assert.deepEqual(verifyCitations('It costs $1.5k/year [1].', src).unsupported, []);
});

test('comma-style citations are understood, and versions like "v24" support "24"', () => {
  const src = new Map([[14, 'Node.js v24.11.1 (LTS) and v22.21.0 (LTS).'], [19, 'Releases: Node 26 Current.']]);
  const v = verifyCitations('Active LTS lines are Node.js 24 and 22 [14, 19]. Supabase Pro is $30 [14, 19].', src);
  assert.equal(v.checked, 3);
  assert.deepEqual(v.unsupported.map((u) => u.value), ['$30']);
  assert.deepEqual(v.unsupported[0]!.cites, [14, 19]);
});

test('citations to sources we have no text for are skipped, not flagged', () => {
  assert.deepEqual(verifyCitations('Costs $99 [7].', sources).unsupported, []);
});

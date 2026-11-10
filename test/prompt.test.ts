import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRecheck } from '../src/agent/prompt.ts';

test('re-check intent is recognised in the many ways people phrase it', () => {
  for (const q of [
    'Has any pricing changed since then?',
    'Is your answer still correct today?',
    'is it still the cheapest?',
    'Are those prices current?',
    'what are they now?',
    'Has any of them shipped something big?',
    'anything new with those?',
    'can you double-check that?',
    'does that still hold up?',
    'Is that up-to-date?',
  ]) assert.ok(isRecheck(q), q);
});

test('plain recall questions are not re-checks', () => {
  for (const q of ['What did I ask you on 3 November?', 'Which CRMs did we talk about?', 'Remind me what you told me about Neon']) {
    assert.ok(!isRecheck(q), q);
  }
});

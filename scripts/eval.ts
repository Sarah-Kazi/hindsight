import path from 'node:path';
import { ask, lastWeekdayAt11, makeAgent, SEED_CONVERSATIONS, type TurnRecord } from './harness.ts';

/**
 * Live behavioural eval against the brief's scenarios (real model + real search).
 * Each scenario gets a fresh memory store; history is created by actually
 * running the agent on a back-dated clock.
 *
 * Checks are deliberately simple heuristics for the behaviour that matters most:
 * no invented memories, date-scoped re-checks, parallel fan-out, no needless
 * searching. Read the printed answers too.
 */

type Check = [label: string, ok: boolean];
interface Scenario {
  name: string;
  run: (dir: string) => Promise<{ final: TurnRecord; checks: Check[] }>;
}

/** Runs a back-dated seed turn; a failure is printed loudly instead of silently skewing the follow-up. */
async function seedOrReport(agent: ReturnType<typeof makeAgent>['agent'], text: string, at: Date): Promise<boolean> {
  const r = await ask(agent, text, { now: at, quiet: true });
  await agent.idle();
  const ok = !r.error && r.answer.trim().length > 0;
  console.log(ok ? `  ✓ seed answered (${r.searches.length} searches, ${(r.totalMs / 1000).toFixed(1)} s)` : `  ✕ SEED FAILED: ${r.error ?? 'empty answer'}. The follow-up below is not a fair test.`);
  return ok;
}

const ADMITS_NO_RECORD = /(don't|do not|can't|cannot|couldn't|no)\b[^.]{0,60}\b(record|history|memory|conversation|find|have)/i;

const scenarios: Scenario[] = [
  {
    name: 'Cold memory: "What did I ask you on 3 November?"',
    async run(dir) {
      const { agent } = makeAgent(dir);
      const final = await ask(agent, 'What did I ask you on 3 November? Is your answer still correct today?');
      return { final, checks: [['admits there is no record', ADMITS_NO_RECORD.test(final.answer)], ['does not search the web for it', final.searches.length === 0]] };
    },
  },
  {
    name: 'False premise: CRM shortlist that never happened',
    async run(dir) {
      const { agent } = makeAgent(dir);
      const final = await ask(agent, 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?');
      return { final, checks: [['says it has no record of Monday', ADMITS_NO_RECORD.test(final.answer)], ['asks which tools (or offers a default)', /\?/.test(final.answer)]] };
    },
  },
  {
    name: 'Real follow-up: "Last Tuesday I asked you about Postgres hosting…"',
    async run(dir) {
      const { agent } = makeAgent(dir);
      const seed = SEED_CONVERSATIONS[0]!;
      const at = lastWeekdayAt11(seed.weekday);
      console.log('  (seeding last Tuesday…)');
      const seeded = await seedOrReport(agent, seed.text, at);
      const final = await ask(agent, 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?');
      const sinceDay = at.toLocaleDateString('en-CA');
      return {
        final,
        checks: [
          ['seed conversation was answered', seeded],
          ['recalled the Tuesday conversation', final.recalled >= 1],
          ['searched for changes since that day', final.searches.some((s) => s.since === sinceDay)],
          ['also read current state (no date filter)', final.searches.some((s) => !s.since)],
          ['fanned out (≥3 searches)', final.searches.length >= 3],
        ],
      };
    },
  },
  {
    name: 'Real follow-up: "On Monday we shortlisted 5 CRM tools…"',
    async run(dir) {
      const { agent } = makeAgent(dir);
      const seed = SEED_CONVERSATIONS[1]!;
      console.log('  (seeding last Monday…)');
      const seeded = await seedOrReport(agent, seed.text, lastWeekdayAt11(seed.weekday));
      const final = await ask(agent, 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?');
      return { final, checks: [['seed conversation was answered', seeded], ['recalled Monday', final.recalled >= 1], ['checked each tool (≥5 searches)', final.searches.length >= 5]] };
    },
  },
  {
    name: 'Small talk needs no search',
    async run(dir) {
      const { agent } = makeAgent(dir);
      const final = await ask(agent, 'hey! what can you help me with?');
      return { final, checks: [['no searches', final.searches.length === 0]] };
    },
  },
  {
    name: 'Fresh fact needs a search',
    async run(dir) {
      const { agent } = makeAgent(dir);
      const final = await ask(agent, "What's the latest stable version of Node.js right now?");
      return { final, checks: [['searched', final.searches.length >= 1], ['cites sources', /\[\d+\]/.test(final.answer)]] };
    },
  },
];

const only = process.argv[2];
const root = path.resolve('.eval-data', `run-${Date.now()}`);
const summary: Array<{ name: string; passed: number; total: number; ttft: number | null; total_s: number; searches: number }> = [];

for (const [i, s] of scenarios.entries()) {
  if (only && !String(i + 1).startsWith(only)) continue;
  console.log(`\n━━ ${i + 1}. ${s.name}`);
  const { final, checks } = await s.run(path.join(root, `s${i + 1}`));
  console.log(`\n  Q: ${final.text}\n`);
  console.log(final.answer.split('\n').map((l) => `  │ ${l}`).join('\n'));
  if (final.error) console.log(`  ✕ error: ${final.error}`);
  for (const [label, ok] of checks) console.log(`  ${ok ? '✓' : '✕'} ${label}`);
  summary.push({
    name: s.name,
    passed: checks.filter(([, ok]) => ok).length,
    total: checks.length,
    ttft: final.firstTokenMs,
    total_s: final.totalMs / 1000,
    searches: final.searches.length,
  });
}

console.log('\n━━ Summary');
console.table(summary.map((r) => ({ scenario: r.name.slice(0, 48), checks: `${r.passed}/${r.total}`, 'first token (s)': r.ttft != null ? (r.ttft / 1000).toFixed(1) : '-', 'total (s)': r.total_s.toFixed(1), searches: r.searches })));

import { config } from '../src/config.ts';
import { formatDay, localDay } from '../src/time.ts';
import { ask, lastWeekdayAt11, makeAgent, SEED_CONVERSATIONS, TZ } from './harness.ts';

/**
 * Creates REAL past conversations (real model, real search) dated last Tuesday
 * and last Monday, so the brief's memory questions can be tried immediately:
 *   "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"
 *   "On Monday we shortlisted 5 CRM tools… Has any of them changed pricing since?"
 * The answers are genuine; only their timestamps are moved back. They are
 * tagged "seeded" in the UI so nobody mistakes them for organic history.
 */

const { store, agent } = makeAgent(config.dataDir);
for (const c of SEED_CONVERSATIONS) {
  const at = lastWeekdayAt11(c.weekday);
  console.log(`\n▶ ${formatDay(localDay(at, TZ))}: ${c.text}`);
  const r = await ask(agent, c.text, { now: at, seeded: true });
  if (r.error) console.error(`  ✕ ${r.error}`);
  else console.log(`  ✓ answered with ${r.searches.length} searches`);
}
await agent.idle();
store.flush();
console.log(`\nSeeded into ${config.dataDir}. Start the app with: npm run dev`);

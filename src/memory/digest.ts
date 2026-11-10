import { generateText, Output, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { Digest, Message } from './store.ts';

/**
 * After each answer, a cheap model writes a compact "digest" of the exchange:
 * a title, a one-line summary, topic keywords (including synonyms, so recall
 * can match "database hosting" to "Postgres"), and a CLAIMS LEDGER of the
 * specific facts stated.
 *
 * The ledger is an index, not the truth: recall always shows the model the
 * original answer text next to it, so an extraction error can't silently
 * become a wrong "then" value.
 *
 * Runs off the critical path, never delays a reply. Skipped for small talk
 * to save rate limit.
 */

const schema = z.object({
  title: z.string().describe('3–6 word title for this topic, e.g. "Postgres hosting pricing"'),
  summary: z.string().describe('One sentence: what the user wanted and what the answer concluded.'),
  topics: z.array(z.string()).describe('3–8 lowercase keywords incl. category and synonyms, e.g. ["postgres hosting","managed database","pricing","serverless postgres"]'),
  entities: z.array(z.string()).describe('Named products, companies, people, places discussed'),
  claims: z
    .array(
      z.object({
        entity: z.string(),
        attribute: z.string().describe('e.g. "Pro plan price", "free tier storage", "latest version"'),
        value: z.string().describe('Exactly as stated in the answer, with units/currency/period'),
        source: z.number().int().nullable().describe('Citation number [n] the answer used for this, or null'),
      }),
    )
    .describe('Up to 20 specific, checkable facts from the answer (prices, limits, dates, versions, features). Empty if none.'),
});

export async function writeDigest(model: LanguageModel, user: Message, assistant: Message, providerOptions?: Record<string, Record<string, unknown>>): Promise<Digest> {
  const fallback = heuristicDigest(user, assistant);
  const trivial = !assistant.searches?.length && assistant.content.length < 500;
  if (trivial) return fallback;

  const { output } = await generateText({
    model,
    providerOptions: providerOptions as never,
    output: Output.object({ schema }),
    maxRetries: 4,
    prompt:
      'Index this exchange for long-term memory. Extract only what the ANSWER actually states, never add outside facts.\n\n' +
      `<question>\n${user.content}\n</question>\n<answer>\n${assistant.content}\n</answer>`,
  });
  if (!output) return fallback;
  return {
    title: output.title.trim().slice(0, 80) || fallback.title,
    summary: output.summary.trim(),
    topics: output.topics.map((t) => t.toLowerCase().trim()).filter(Boolean).slice(0, 10),
    entities: output.entities.map((e) => e.trim()).filter(Boolean).slice(0, 20),
    claims: output.claims.slice(0, 20),
    by: 'llm',
  };
}

export function heuristicDigest(user: Message, assistant: Message): Digest {
  const q = user.content.replace(/\s+/g, ' ').trim();
  const words = q.split(' ');
  const title = words.slice(0, 7).join(' ') + (words.length > 7 ? '…' : '');
  const entities = [...new Set((user.content + ' ' + assistant.content).match(/\b[A-Z][a-zA-Z0-9]+(?:\s[A-Z][a-zA-Z0-9]+)?\b/g) ?? [])].slice(0, 12);
  return { title, summary: q.slice(0, 200), topics: [], entities, claims: [], by: 'heuristic' };
}

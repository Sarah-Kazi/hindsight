import type { ModelMessage } from 'ai';
import type { Message, SourceRef } from '../memory/store.ts';
import { citedNumbers } from './verify.ts';

const NO_ANSWER = '(No answer was given to this message: it failed or was cancelled.)';

/**
 * Recent in-thread history within a character budget (~4 chars/token).
 * Older turns drop out of the window but stay reachable via memory recall.
 */
export function buildHistory(prior: Message[], budget: number): { messages: ModelMessage[]; includedAssistantIds: Set<string> } {
  const usable = prior.filter((m) => m.role === 'user' || m.content.trim());
  const picked: Message[] = [];
  let used = 0;
  for (let i = usable.length - 1; i >= 0; i--) {
    const m = usable[i]!;
    const size = render(m).length;
    if (used + size > budget && picked.length) break;
    picked.unshift(m);
    used += size;
  }
  while (picked[0]?.role === 'assistant') picked.shift(); // must start with a user turn

  const messages: ModelMessage[] = [];
  for (const m of picked) {
    // Keep roles alternating: a failed turn leaves two user messages in a row.
    if (messages.at(-1)?.role === 'user' && m.role === 'user') messages.push({ role: 'assistant', content: NO_ANSWER });
    messages.push({ role: m.role, content: render(m) });
  }
  if (messages.at(-1)?.role === 'user') messages.push({ role: 'assistant', content: NO_ANSWER });
  return { messages, includedAssistantIds: new Set(picked.filter((m) => m.role === 'assistant').map((m) => m.id)) };
}

/** An earlier answer as the model sees it: with its cited sources, so follow-ups can refer to them. */
function render(m: Message): string {
  if (m.role === 'user') return m.content;
  let s = m.content;
  if (m.status === 'aborted') s += '\n\n[This answer was stopped by the user before it finished.]';
  const cited = new Set(citedNumbers(m.content));
  const srcs = (m.sources ?? []).filter((x) => cited.has(x.n));
  if (srcs.length) s += `\n\nSources: ${srcs.map((x) => `[${x.n}] ${x.url}`).join(' ')}`;
  return s;
}

/** Cited sources first (in citation order), then the rest that were consulted. */
export function citedFirst(sources: SourceRef[], answer: string): SourceRef[] {
  const cited = new Set(citedNumbers(answer));
  return [...sources.filter((s) => cited.has(s.n)), ...sources.filter((s) => !cited.has(s.n))];
}

/** What the browser gets: no digests, no stored page excerpts. */
export function publicMessage(m: Message): Message {
  const { digest, ...rest } = m;
  return { ...rest, sources: m.sources?.map(({ excerpt, ...s }) => s) };
}

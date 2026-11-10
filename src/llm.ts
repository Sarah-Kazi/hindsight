import type { LanguageModel } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { config, type Provider } from './config.ts';

/**
 * The only provider-specific file. The Vercel AI SDK gives one interface for
 * streaming and parallel tool calls across vendors; the agent loop itself is
 * our own code in agent/turn.ts.
 *
 * `chain` is the fallback order for answering: the configured model, then the
 * same provider's cheaper model (separate rate-limit bucket on most free
 * tiers), then any other provider whose key is present. A 429 or outage on
 * one model becomes a slightly different answer, not an error.
 */

type ProviderOptions = Record<string, Record<string, unknown>>;

export interface ModelSlot {
  provider: Provider;
  id: string;
  model: LanguageModel;
  options?: ProviderOptions;
}

export interface Models {
  provider: Provider;
  main: LanguageModel;
  fast: LanguageModel;
  mainId: string;
  fastId: string;
  fastOptions?: ProviderOptions;
  chain?: ModelSlot[];
}

const DEFAULT_MAIN: Record<Provider, string> = { gemini: 'gemini-3.5-flash', anthropic: 'claude-sonnet-5-5', openai: 'gpt-5.5' };
const KEY_ENV: Record<Provider, string> = { gemini: 'GOOGLE_GENERATIVE_AI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };

function make(provider: Provider, id: string): LanguageModel {
  switch (provider) {
    case 'gemini':
      return createGoogleGenerativeAI()(id);
    case 'anthropic':
      return createAnthropic()(id);
    case 'openai':
      return createOpenAI()(id);
  }
}

/**
 * Gemini 3+ "thinks" by default: measured ~500 hidden reasoning tokens and
 * 4–6 s before the first word on simple replies. This task's reasoning is mostly
 * done in code (dates, memory), so low thinking is the right trade-off.
 * Override with GEMINI_THINKING=minimal|low|medium|high.
 */
function optionsFor(provider: Provider, id: string): ProviderOptions | undefined {
  if (provider === 'gemini' && /^gemini-[3-9]/.test(id)) {
    return { google: { thinkingConfig: { thinkingLevel: process.env.GEMINI_THINKING?.trim() || 'low' } } };
  }
  return undefined;
}

const slot = (provider: Provider, id: string): ModelSlot => ({ provider, id, model: make(provider, id), options: optionsFor(provider, id) });

let cached: Models | null = null;

export function getModels(): Models | null {
  if (cached) return cached;
  if (!config.provider || !config.hasModelKey) return null;
  const p = config.provider;
  const chain: ModelSlot[] = [slot(p, config.mainModel)];
  if (config.fastModel !== config.mainModel) chain.push(slot(p, config.fastModel));
  for (const other of Object.keys(KEY_ENV) as Provider[]) {
    if (other !== p && process.env[KEY_ENV[other]]?.trim()) chain.push(slot(other, DEFAULT_MAIN[other]));
  }
  cached = {
    provider: p,
    main: chain[0]!.model,
    fast: make(p, config.fastModel),
    mainId: config.mainModel,
    fastId: config.fastModel,
    fastOptions: optionsFor(p, config.fastModel),
    chain,
  };
  return cached;
}

/** The answering chain for a Models object (tests may pass one without a chain). */
export function answerChain(m: Models): ModelSlot[] {
  return m.chain?.length ? m.chain : [{ provider: m.provider, id: m.mainId, model: m.main }];
}

/**
 * Models that just failed with a rate limit or outage are tried last for a
 * while, so the next message doesn't pay the same 3 s failure again.
 */
const cooldowns = new Map<string, number>();

export function coolDown(id: string, ms: number): void {
  cooldowns.set(id, Date.now() + ms);
}

export function byAvailability(chain: ModelSlot[]): ModelSlot[] {
  const now = Date.now();
  const until = (s: ModelSlot) => cooldowns.get(s.id) ?? 0;
  const ready = chain.filter((s) => until(s) <= now);
  const cooling = chain.filter((s) => until(s) > now).sort((a, b) => until(a) - until(b));
  return [...ready, ...cooling];
}

export function resetCooldowns(): void {
  cooldowns.clear();
}

import 'dotenv/config';
import path from 'node:path';

export type Provider = 'gemini' | 'anthropic' | 'openai';

const KEY_ENV: Record<Provider, string> = {
  gemini: 'GOOGLE_GENERATIVE_AI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

/** Main model answers the user; fast model writes background memory digests. */
const DEFAULT_MODELS: Record<Provider, { main: string; fast: string }> = {
  gemini: { main: 'gemini-3.5-flash', fast: 'gemini-3.5-flash-lite' },
  anthropic: { main: 'claude-sonnet-5-5', fast: 'claude-haiku-5-5' },
  openai: { main: 'gpt-5.5', fast: 'gpt-5.4-mini' },
};

// Accept the name people usually have from Google AI Studio docs.
if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && process.env.GEMINI_API_KEY) {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY;
}

function pickProvider(): Provider | null {
  const forced = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (forced) {
    if (forced in KEY_ENV) return forced as Provider;
    console.warn(`[config] Unknown LLM_PROVIDER "${forced}" — ignoring.`);
  }
  for (const p of Object.keys(KEY_ENV) as Provider[]) {
    if (process.env[KEY_ENV[p]]?.trim()) return p;
  }
  return null;
}

const provider = pickProvider();

export const config = {
  provider,
  providerKeyEnv: provider ? KEY_ENV[provider] : null,
  hasModelKey: provider ? Boolean(process.env[KEY_ENV[provider]]?.trim()) : false,
  mainModel: process.env.LLM_MODEL?.trim() || (provider ? DEFAULT_MODELS[provider].main : ''),
  fastModel: process.env.LLM_FAST_MODEL?.trim() || (provider ? DEFAULT_MODELS[provider].fast : ''),
  tavilyKey: process.env.TAVILY_API_KEY?.trim() || '',
  searchDepth: (process.env.SEARCH_DEPTH === 'basic' ? 'basic' : 'advanced') as 'basic' | 'advanced',
  port: Number(process.env.PORT) || 3000,
  dataDir: path.resolve(process.env.DATA_DIR || './data'),

  // Agent loop limits — bound latency and cost on every turn.
  maxSteps: 6, // model calls per turn (the last one is forced to answer without tools)
  maxSearchesPerTurn: 16,
  searchConcurrency: 4, // parallel searches in flight (free-tier friendly)
  softDeadlineMs: 45_000, // after this, no more searching: answer with what you have
  hardDeadlineMs: 120_000, // after this, stop the turn and keep the partial answer
  historyCharBudget: 40_000, // ~10k tokens of in-thread history
  maxUserMessageChars: 20_000,
};

export function configProblems(): string[] {
  const problems: string[] = [];
  if (!config.provider) {
    problems.push('No model API key found. Set GOOGLE_GENERATIVE_AI_API_KEY (free), ANTHROPIC_API_KEY or OPENAI_API_KEY in .env.');
  } else if (!config.hasModelKey) {
    problems.push(`LLM_PROVIDER is "${config.provider}" but ${config.providerKeyEnv} is empty.`);
  }
  if (!config.tavilyKey) problems.push('TAVILY_API_KEY is missing, so web search is disabled (free key at tavily.com).');
  return problems;
}

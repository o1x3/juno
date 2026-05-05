import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';

import type { AgentConfig } from '@/types';

const PROMPT = [
  'Produce a 3-word kebab-case slug summarizing the user request.',
  'Output ONLY the slug, no quotes, no punctuation other than hyphens.',
  'Example: "refactor-session-storage", "wire-version-flag", "clean-failing-tests".',
].join(' ');

export type NamingDeps = {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

function sanitizeSlug(raw: string): string | undefined {
  const trimmed = raw
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, '');
  const slug = trimmed
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) return undefined;
  const words = slug.split('-').filter(Boolean).slice(0, 4);
  if (words.length === 0) return undefined;
  return words.join('-');
}

export async function generateSessionName(
  firstUserMessage: string,
  config: AgentConfig,
  deps: NamingDeps = {},
): Promise<string | undefined> {
  const apiKey = deps.apiKey ?? config.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) return undefined;
  const provider = createOpenAI({
    apiKey,
    baseURL: deps.baseUrl ?? config.baseUrl,
    fetch: deps.fetchImpl,
  });
  const timeout = deps.timeoutMs ?? 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const result = await generateText({
      model: provider.responses(config.namingModel),
      system: PROMPT,
      prompt: firstUserMessage,
      abortSignal: controller.signal,
    });
    return sanitizeSlug(result.text);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

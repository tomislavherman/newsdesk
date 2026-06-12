import { PostHogAnthropic } from '@posthog/ai/anthropic';
import type Anthropic from '@anthropic-ai/sdk';
import posthog from './posthog.js';
import { getRecentFeedback } from './db.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client = new PostHogAnthropic({
  posthog,
  apiKey: process.env.ANTHROPIC_API_KEY ?? '',
  ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}),
} as ConstructorParameters<typeof PostHogAnthropic>[0]);

const MODEL = process.env.AI_MODEL ?? 'claude-haiku-4-5-20251001';
const CACHE_MIN_TOKENS = 4096;

export interface ClassifyResult {
  summary: string | null;
  is_relevant: boolean;
  reason: string | null;
}

export interface AnalyzeSourceResult {
  has_rss: boolean;
  feed_url: string | null;
  selector: string | null;
  date_selector: string | null;
  image_selector: string | null;
  name: string;
  _log: {
    model: string;
    prompt: string;
    raw_response: string;
    parsed: unknown;
  } | null;
}

function parseJson(text: string): unknown {
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const match = text.match(/\{[\s\S]*\}/) ?? text.match(/\[[\s\S]*\]/);
  for (const candidate of [text, stripped, match?.[0]]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch { /* try next */ }
  }
  throw new Error('No JSON found in response');
}

function estimateTokens(text: string): number {
  return Math.floor(text.length / 4);
}

function extractText(message: Anthropic.Message): string {
  const block = message.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  if (!block) throw new Error('No text block in AI response');
  return block.text;
}

function buildClassifyPrefix(userId: number | null): string {
  const recentFeedback = userId ? getRecentFeedback(userId, 50) : [];

  const feedbackSection = recentFeedback.length > 0
    ? `\nThe user has previously dismissed these articles as not interesting:\n${recentFeedback.map(f => `- "${f.title}"${f.reason ? ` (reason: ${f.reason})` : ''}`).join('\n')}\n\nBased only on these dismissals, set is_relevant to false if this article clearly matches the same pattern. If there is no clear match, default to true.`
    : '';

  return `Summarize each article and assess relevance. For each article return a JSON object with:
- summary (string): 2-3 neutral factual sentences summarizing the article
- is_relevant (boolean): true by default; false only if the article clearly matches patterns from the user's dismissed articles below${feedbackSection ? '' : ' (no dismissals yet — always true)'}
- reason (string|null): if is_relevant is false, a single sentence explaining why this article matches the user's dismissed patterns. null if is_relevant is true.
${feedbackSection}
Return a JSON array with one object per article in the same order as the input.
Return only valid JSON, no explanation.`;
}

// Called only after RSS validation has already failed — does HTML selector detection via Claude.
export async function analyzeSource(url: string, html: string, userId: number | null = null): Promise<AnalyzeSourceResult> {
  const { load } = await import('cheerio');
  const $ = load(html);
  $('script, style, svg, noscript, meta').remove();
  const main = $('main, [role="main"]').first();
  const body = main.length ? $.html(main) : $.html($('body'));
  const truncated = body.slice(-30000);

  const prompt = `Analyze this news site HTML and identify article selectors. Return a JSON object with:
- has_rss (boolean): false
- feed_url (string|null): null
- selector (string|null): CSS selector matching the repeating article/post container elements — look for <article>, <li>, <tr>, <div> that repeat and each contain a headline link. Prefer tag-based selectors with class names (e.g. "tr.athing", "li.post"). Return null only if you truly cannot identify a pattern.
- date_selector (string|null): CSS selector (relative to each container) for the publish date, e.g. "time", "[datetime]", ".date". Return null if not visible.
- image_selector (string|null): CSS selector (relative to each container) for a thumbnail image, e.g. "img", ".thumbnail img". Return null if no images present.
- name (string): short human-readable name for this source

Important rules for selector detection:
- The article link inside each container must point to an article page, not to navigation junk (e.g. not "vote?id=...", "item?id=...", "/comments/...", author profiles, tag/category index pages). Same-domain article links like "/category/article-slug" are fine — publisher sites link to their own articles.
- The title text must be the article headline only — exclude rank numbers (e.g. "1.", "28."), bullet points, or other list prefixes that appear in sibling elements outside the link itself.

URL: ${url}

HTML (last 30000 chars of body, scripts/styles stripped):
${truncated}

Return only valid JSON, no explanation.`;

  const message = await (client as unknown as Anthropic).messages.create({
    model: MODEL,
    max_tokens: 8192,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
    ...(userId ? { posthogDistinctId: String(userId) } : {}),
  } as Parameters<Anthropic['messages']['create']>[0]) as Anthropic.Message;

  const rawResponse = extractText(message);
  const parsed = parseJson(rawResponse);

  return {
    ...(parsed as object),
    _log: { model: MODEL, prompt, raw_response: rawResponse, parsed },
  } as AnalyzeSourceResult;
}

export async function summarizeArticles(
  articles: Array<{ title: string | null; content: string }>,
  userId: number | null = null
): Promise<{ results: ClassifyResult[]; _log: { model: string; prompt: string; raw_response: string } | null }> {
  if (articles.length === 0) return { results: [], _log: null };

  const prefix = buildClassifyPrefix(userId);
  const shouldCache = estimateTokens(prefix) >= CACHE_MIN_TOKENS;

  const articlesPart = articles
    .map((a, i) => `Article ${i + 1}\nTitle: ${a.title}\nContent: ${a.content?.slice(0, 3000) ?? '(no content)'}`)
    .join('\n\n');

  const cacheControl = { type: 'ephemeral' as const, ttl: '1h' } as { type: 'ephemeral' };

  const message = await (client as unknown as Anthropic).messages.create({
    model: MODEL,
    max_tokens: Math.max(4096, articles.length * 300),
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text' as const,
          text: prefix,
          ...(shouldCache ? { cache_control: cacheControl } : {}),
        },
        { type: 'text' as const, text: articlesPart },
      ],
    }],
    ...(userId ? { posthogDistinctId: String(userId) } : {}),
  } as Parameters<Anthropic['messages']['create']>[0]) as Anthropic.Message;

  const rawResponse = extractText(message);
  const parsed = parseJson(rawResponse);
  const results: ClassifyResult[] = Array.isArray(parsed) ? parsed as ClassifyResult[] : [parsed as ClassifyResult];

  while (results.length < articles.length) {
    results.push({ summary: null, is_relevant: true, reason: null });
  }

  return { results, _log: { model: MODEL, prompt: prefix + '\n\n' + articlesPart, raw_response: rawResponse } };
}

export async function warmClassifyCache(userId: number): Promise<void> {
  const prefix = buildClassifyPrefix(userId);
  if (estimateTokens(prefix) < CACHE_MIN_TOKENS) return;

  const cacheControl = { type: 'ephemeral' as const, ttl: '1h' } as { type: 'ephemeral' };

  await (client as unknown as Anthropic).messages.create({
    model: MODEL,
    max_tokens: 1,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text' as const,
          text: prefix,
          cache_control: cacheControl,
        },
        { type: 'text' as const, text: 'ping' },
      ],
    }],
    ...(userId ? { posthogDistinctId: String(userId) } : {}),
  } as Parameters<Anthropic['messages']['create']>[0]);
}

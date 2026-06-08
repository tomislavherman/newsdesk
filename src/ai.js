import { PostHogAnthropic } from '@posthog/ai/anthropic';
import posthog from './posthog.js';
import { getRecentFeedback } from './db.js';

const client = new PostHogAnthropic({ posthog });
const MODEL = 'claude-haiku-4-5-20251001';
const CACHE_MIN_TOKENS = 1024;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('No JSON found in response');
  }
}

function estimateTokens(text) {
  return Math.floor(text.length / 4);
}

function buildClassifyPrefix(userId) {
  const recentFeedback = userId ? getRecentFeedback(userId, 50) : [];

  const feedbackSection = recentFeedback.length > 0
    ? `\nThe user has previously dismissed these articles as not interesting:\n${recentFeedback.map(f => `- "${f.title}"${f.reason ? ` (reason: ${f.reason})` : ''}`).join('\n')}\n\nBased only on these dismissals, set is_relevant to false if this article clearly matches the same pattern. If there is no clear match, default to true.`
    : '';

  return `Summarize this article and assess relevance. Return a JSON object with:
- summary (string): 2-3 neutral factual sentences summarizing the article
- is_relevant (boolean): true by default; false only if the article clearly matches patterns from the user's dismissed articles below${feedbackSection ? '' : ' (no dismissals yet — always true)'}
- reason (string|null): if is_relevant is false, a single sentence explaining why this article matches the user's dismissed patterns. null if is_relevant is true.
${feedbackSection}
Return only valid JSON, no explanation.`;
}

// Called only after RSS validation has already failed — does HTML selector detection via Claude.
export async function analyzeSource(url, html, userId = null) {
  const $ = (await import('cheerio')).load(html);
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
- The article link inside each container must point to the EXTERNAL article URL, not to internal site navigation (e.g. not "vote?id=...", "item?id=...", "/comments/...", or same-domain links). Look for <a href="https://..."> pointing to a different domain.
- The title text must be the article headline only — exclude rank numbers (e.g. "1.", "28."), bullet points, or other list prefixes that appear in sibling elements outside the link itself.

URL: ${url}

HTML (last 30000 chars of body, scripts/styles stripped):
${truncated}

Return only valid JSON, no explanation.`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
    ...(userId ? { posthogDistinctId: String(userId) } : {}),
  });

  const rawResponse = message.content[0].text;
  const parsed = parseJson(rawResponse);

  return {
    ...parsed,
    _log: { model: MODEL, prompt, raw_response: rawResponse, parsed },
  };
}

export async function summarizeArticle(title, content, userId = null) {
  const prefix = buildClassifyPrefix(userId);
  const shouldCache = estimateTokens(prefix) >= CACHE_MIN_TOKENS;

  const articlePart = `Article title: ${title}
Article content: ${content?.slice(0, 3000) ?? '(no content)'}`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: prefix,
          ...(shouldCache ? { cache_control: { type: 'ephemeral', ttl: 3600 } } : {}),
        },
        { type: 'text', text: articlePart },
      ],
    }],
    ...(userId ? { posthogDistinctId: String(userId) } : {}),
  });

  const rawResponse = message.content[0].text;
  const parsed = parseJson(rawResponse);

  return {
    ...parsed,
    _log: { model: MODEL, prefix, article_part: articlePart, raw_response: rawResponse, parsed },
  };
}

export async function warmClassifyCache(userId) {
  const prefix = buildClassifyPrefix(userId);
  if (estimateTokens(prefix) < CACHE_MIN_TOKENS) return;

  await client.messages.create({
    model: MODEL,
    max_tokens: 1,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: prefix,
          cache_control: { type: 'ephemeral', ttl: 3600 },
        },
        { type: 'text', text: 'ping' },
      ],
    }],
    ...(userId ? { posthogDistinctId: String(userId) } : {}),
  });
}

import Anthropic from '@anthropic-ai/sdk';
import { getRecentFeedback } from './db.js';

const client = new Anthropic();
const MODEL = 'claude-haiku-4-5-20251001';

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('No JSON found in response');
  }
}

export async function analyzeSource(url, html) {
  const truncated = html.slice(0, 15000);
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `Analyze this news site HTML and return a JSON object with these fields:
- has_rss (boolean): true if you find an RSS/Atom feed link
- feed_url (string|null): the RSS feed URL if found, else null
- selector (string|null): a CSS selector targeting article link containers if no RSS, else null
- name (string): a short human-readable name for this news source

URL: ${url}

HTML (first 15000 chars):
${truncated}

Return only valid JSON, no explanation.`
    }]
  });

  return parseJson(message.content[0].text);
}

export async function classifyArticle(title, content) {
  const recentFeedback = getRecentFeedback(20);
  const feedbackContext = recentFeedback.length > 0
    ? `\nThe user has dismissed these articles as not interesting (learn from these):\n${recentFeedback.map(f => `- "${f.title}"${f.reason ? ` (reason: ${f.reason})` : ''}`).join('\n')}\n`
    : '';

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `You are a news relevance filter for a personal news reader. Classify this article and return a JSON object with:
- is_relevant (boolean): whether this article is worth reading
- reason (string): one sentence explaining the relevance decision
- summary (string): 2-3 sentence neutral factual summary of the article
${feedbackContext}
Article title: ${title}
Article content: ${content?.slice(0, 2000) ?? '(no content)'}

Return only valid JSON, no explanation.`
    }]
  });

  return parseJson(message.content[0].text);
}

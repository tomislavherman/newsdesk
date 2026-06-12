/**
 * Benchmark: compare article classification across two AI providers.
 *
 * Usage:
 *   npm run benchmark [articles] [userId]
 *
 * Env vars:
 *   CLAUDE_API_KEY      — required for Claude
 *   CLAUDE_MODEL        — defaults to claude-haiku-4-5-20251001
 *   DEEPSEEK_API_KEY    — required for DeepSeek
 *   DEEPSEEK_MODEL      — defaults to deepseek-v4-flash
 */

import Anthropic from '@anthropic-ai/sdk';
import Database from 'better-sqlite3';
import { fetch } from 'undici';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ─────────────────────────────────────────────────────────────────────

const N       = parseInt(process.argv[2] ?? '10');
const USER_ID = parseInt(process.argv[3] ?? '1');

interface Provider {
  name: string;
  model: string;
  apiKey: string | undefined;
  baseURL: string;
  inputPricePer1M: number;
  outputPricePer1M: number;
}

// Pricing per 1M tokens (USD) — verify at each provider's docs before trusting cost estimates
const PROVIDERS: Provider[] = [
  {
    name: 'Claude',
    model: process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5-20251001',
    apiKey: process.env.CLAUDE_API_KEY ?? process.env.ANTHROPIC_API_KEY,
    baseURL: 'https://api.anthropic.com',
    inputPricePer1M:  1.00,
    outputPricePer1M: 5.00,
  },
  {
    name: 'DeepSeek',
    model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: 'https://api.deepseek.com/anthropic',
    inputPricePer1M:  0.14,
    outputPricePer1M: 0.28,
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function parseJson(text: string): unknown {
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const match = text.match(/\{[\s\S]*\}/) ?? text.match(/\[[\s\S]*\]/);
  for (const candidate of [text, stripped, match?.[0]]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch { /* try next */ }
  }
  return null;
}

async function fetchContent(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Newsdesk-Benchmark/1.0)' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3000);
  } catch {
    return null;
  }
}

interface ArticleInput {
  title: string | null;
  content: string;
}

type MessageParam = Anthropic.Messages.MessageParam;

function buildMessages(articles: ArticleInput[]): MessageParam[] {
  const prefix = `Summarize each article and assess relevance. For each article return a JSON object with:
- summary (string): 2-3 neutral factual sentences summarizing the article
- is_relevant (boolean): true by default; false only if clearly off-topic or low quality
- reason (string|null): if is_relevant is false, one sentence explaining why. null otherwise.

Return a JSON array with one object per article in the same order as the input.
Return only valid JSON, no explanation.`;

  const body = articles
    .map((a, i) => `Article ${i + 1}\nTitle: ${a.title}\nContent: ${a.content || '(no content)'}`)
    .join('\n\n');

  return [{ role: 'user', content: [{ type: 'text', text: prefix }, { type: 'text', text: body }] }];
}

function estimateCost(tokens: { input: number; output: number }, provider: Provider): number {
  return (tokens.input / 1_000_000) * provider.inputPricePer1M
       + (tokens.output / 1_000_000) * provider.outputPricePer1M;
}

function pad(str: string | number, width: number): string { return String(str).padEnd(width); }
function num(n: number, d = 0): string { return Number(n).toLocaleString('en-US', { maximumFractionDigits: d }); }

interface ClassifyResult {
  is_relevant?: boolean;
  summary?: string;
  reason?: string;
}

interface RunResult {
  elapsed: number;
  tokens: { input: number; output: number };
  results: (ClassifyResult | null)[];
}

async function runProvider(provider: Provider, articles: ArticleInput[]): Promise<RunResult> {
  const client = new Anthropic({ apiKey: provider.apiKey, baseURL: provider.baseURL });
  const messages = buildMessages(articles);

  const t0 = performance.now();
  const message = await client.messages.create({
    model: provider.model,
    max_tokens: Math.max(4096, articles.length * 300),
    messages,
  });
  const elapsed = performance.now() - t0;

  const block = message.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  if (!block) throw new Error('No text block in response');
  const parsed = parseJson(block.text);
  const results: (ClassifyResult | null)[] = Array.isArray(parsed)
    ? parsed as ClassifyResult[]
    : (parsed ? [parsed as ClassifyResult] : []);

  while (results.length < articles.length) results.push(null);

  return {
    elapsed,
    tokens: { input: message.usage.input_tokens, output: message.usage.output_tokens },
    results,
  };
}

// ── Load articles from DB ──────────────────────────────────────────────────────

interface ArticleRow {
  id: number;
  url: string;
  title: string | null;
  summary: string | null;
  is_relevant: number;
}

const db = new Database(join(__dirname, '..', 'news.db'));
const rows = db.prepare(`
  SELECT a.id, a.url, a.title, a.summary, a.is_relevant
  FROM articles a
  JOIN sources s ON a.source_id = s.id
  WHERE s.user_id = ? AND a.title IS NOT NULL
  ORDER BY a.fetched_at DESC
  LIMIT ?
`).all(USER_ID, N) as ArticleRow[];

if (!rows.length) {
  console.error(`No articles found for user ${USER_ID}. Pass a different userId as the second argument.`);
  process.exit(1);
}

console.log(`\nNewsdesk — AI provider benchmark`);
console.log(`Articles: ${rows.length}  |  User: ${USER_ID}\n`);

process.stdout.write('Fetching article content');
const articles = await Promise.all(rows.map(async (row) => {
  const content = await fetchContent(row.url);
  process.stdout.write('.');
  return { ...row, content: content ?? row.summary ?? '' };
}));
const fetched = articles.filter(a => a.content !== (a.summary ?? '')).length;
console.log(` ${fetched}/${articles.length} live, rest using stored summary\n`);

// ── Run providers ──────────────────────────────────────────────────────────────

const configured = PROVIDERS.filter(p => p.apiKey);
if (configured.length === 0) {
  console.error('No providers configured. Set CLAUDE_API_KEY / ANTHROPIC_API_KEY and DEEPSEEK_API_KEY.');
  process.exit(1);
}
if (configured.length === 1) {
  console.warn(`⚠  Only ${configured[0].name} is configured — no comparison possible. Set the missing API key.\n`);
}

const runs: Record<string, RunResult | null> = {};
for (const provider of configured) {
  process.stdout.write(`Running ${provider.name} (${provider.model})...`);
  try {
    runs[provider.name] = await runProvider(provider, articles);
    console.log(` ${num(runs[provider.name]!.elapsed)} ms`);
  } catch (err) {
    console.log(` FAILED: ${(err as Error).message}`);
    runs[provider.name] = null;
  }
}

// ── Summary table ──────────────────────────────────────────────────────────────

const W = 22;
const completed = configured.filter(p => runs[p.name]);

console.log('\n' + '─'.repeat(W + completed.length * W));
console.log(pad('', W) + completed.map(p => pad(p.name, W)).join(''));
console.log('─'.repeat(W + completed.length * W));

const tableRow = (label: string, fn: (p: Provider, r: RunResult) => string | number) =>
  console.log(pad(label, W) + completed.map(p => pad(fn(p, runs[p.name]!), W)).join(''));

tableRow('Model',            p => p.model);
tableRow('Latency (ms)',     (_, r) => num(r.elapsed));
tableRow('ms / article',    (_, r) => num(r.elapsed / articles.length));
tableRow('Input tokens',    (_, r) => num(r.tokens.input));
tableRow('Output tokens',   (_, r) => num(r.tokens.output));
tableRow('Est. cost (USD)', (p, r) => '$' + estimateCost(r.tokens, p).toFixed(5));
console.log('─'.repeat(W + completed.length * W));

// ── Agreement ──────────────────────────────────────────────────────────────────

if (completed.length >= 2) {
  const [a, b] = completed;
  const rA = runs[a.name]!.results;
  const rB = runs[b.name]!.results;
  let agree = 0;
  for (let i = 0; i < articles.length; i++) {
    if (rA[i] && rB[i] && (rA[i]!.is_relevant !== false) === (rB[i]!.is_relevant !== false)) agree++;
  }
  console.log(`\nClassification agreement: ${agree}/${articles.length} (${Math.round(agree / articles.length * 100)}%)`);
}

// ── Per-article ────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(70));
for (let i = 0; i < articles.length; i++) {
  const art = articles[i];
  console.log(`\n${i + 1}. ${art.title?.slice(0, 80)}`);

  const relevances: boolean[] = [];
  for (const p of completed) {
    const r = runs[p.name]?.results[i];
    if (!r) { console.log(`   ${pad(p.name, 12)} (no result)`); continue; }
    const rel = r.is_relevant !== false;
    relevances.push(rel);
    const tag = rel ? '✓ relevant  ' : '✗ irrelevant';
    const detail = rel
      ? (r.summary?.slice(0, 80) ?? '(no summary)')
      : (r.reason ?? 'no reason given');
    console.log(`   ${pad(p.name, 12)} ${tag}  ${detail}`);
  }
  if (relevances.length === 2 && relevances[0] !== relevances[1]) {
    console.log('   ⚠ DISAGREEMENT');
  }
}

console.log('\n' + '─'.repeat(70));
console.log('Pricing assumptions (verify before relying on cost estimates):');
for (const p of configured) {
  console.log(`  ${p.name}: $${p.inputPricePer1M}/M input, $${p.outputPricePer1M}/M output`);
}
console.log('');

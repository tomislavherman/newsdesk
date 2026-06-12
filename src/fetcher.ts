import { fetch } from 'undici';
import * as cheerio from 'cheerio';
import RSSParser from 'rss-parser';
import { getActiveSources, getSourceById, articleExistsByUrl, insertArticle } from './db.js';
import { analyzeSource, summarizeArticles, warmClassifyCache } from './ai.js';
import type { Source } from './types.js';

type RSSItem = RSSParser.Item & {
  mediaContent?: { $?: { url?: string } } | Array<{ $?: { url?: string } }>;
  mediaThumbnail?: { $?: { url?: string } } | Array<{ $?: { url?: string } }>;
  'content:encoded'?: string;
  enclosure?: { url?: string; type?: string };
};

const rssParser = new RSSParser<Record<string, unknown>, RSSItem>({
  customFields: {
    item: [
      ['media:content', 'mediaContent'],
      ['media:thumbnail', 'mediaThumbnail'],
      ['enclosure', 'enclosure'],
      ['content:encoded', 'content:encoded'],
    ],
  },
});

interface RawArticle {
  url: string;
  title: string | null;
  published_at: string | null;
  image_url: string | null;
}

interface PendingArticle {
  source: Source;
  article: RawArticle;
  content: string;
  image_url: string | null;
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Newsdesk/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function parseDate(text: string | null | undefined): string | null {
  if (!text) return null;
  const d = new Date(text.trim());
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function extractRssImage(item: RSSItem): string | null {
  if (item.enclosure?.url && item.enclosure.type?.startsWith('image/')) return item.enclosure.url;

  const mc = item.mediaContent;
  if (mc) {
    const url = (mc as { $?: { url?: string } })?.$?.url
      ?? (Array.isArray(mc) ? (mc as Array<{ $?: { url?: string } }>)[0]?.$?.url : null);
    if (url) return url;
  }

  const mt = item.mediaThumbnail;
  if (mt) {
    const url = (mt as { $?: { url?: string } })?.$?.url
      ?? (Array.isArray(mt) ? (mt as Array<{ $?: { url?: string } }>)[0]?.$?.url : null);
    if (url) return url;
  }

  const contentHtml = item['content:encoded'] ?? (item.content ?? '');
  if (contentHtml) {
    const match = contentHtml.match(/<img[^>]+src="([^"]+)"/i);
    if (match?.[1] && !match[1].startsWith('data:')) {
      return match[1].split('?')[0];
    }
  }

  return null;
}

async function fetchRssArticles(source: Source): Promise<RawArticle[]> {
  let feed: Awaited<ReturnType<typeof rssParser.parseURL>>;
  try {
    feed = await rssParser.parseURL(source.feed_url!);
  } catch (err) {
    console.error(`[fetch] RSS parse failed for ${source.feed_url}: ${(err as Error).message}`);
    return [];
  }
  return feed.items.map(item => ({
    url: item.link ?? '',
    title: item.title ?? null,
    image_url: extractRssImage(item),
    published_at: item.pubDate ? new Date(item.pubDate).toISOString() : null,
  }));
}

async function fetchHtmlArticles(source: Source): Promise<RawArticle[]> {
  const html = await fetchHtml(source.url);
  const $ = cheerio.load(html);
  const articles: RawArticle[] = [];
  const sourceHost = new URL(source.url).hostname;

  $(source.selector!).each((_, el) => {
    const $el = $(el);

    let bestLink: ReturnType<typeof $> | null = null;
    let bestScore = -1;
    $el.find('a[href]').each((_, a) => {
      const $a = $(a);
      const text = $a.text().trim();
      if (text.length < 4) return;
      let score = text.length;
      try {
        const href = $a.attr('href') ?? '';
        if (href.startsWith('http') && new URL(href).hostname !== sourceHost) score += 20;
      } catch { /* ignore invalid URLs */ }
      if (score > bestScore) { bestScore = score; bestLink = $a; }
    });

    const link = bestLink ?? $el.find('a[href]').first();
    const url = link?.attr('href');
    if (!url) return;

    const absoluteUrl = url.startsWith('http') ? url : new URL(url, source.url).href;

    let published_at: string | null = null;
    if (source.date_selector) {
      published_at = parseDate($el.find(source.date_selector).first().text());
    }

    let image_url: string | null = null;
    if (source.image_selector) {
      const img = $el.find(source.image_selector).first();
      const src = img.attr('src') ?? img.attr('data-src') ?? img.attr('data-lazy-src');
      if (src) image_url = src.startsWith('http') ? src : new URL(src, source.url).href;
    }

    const rawTitle = link.text().trim() || $el.text().trim();
    const title = rawTitle.replace(/^\d+[.)]\s*/, '').trim();
    articles.push({ url: absoluteUrl, title, published_at, image_url });
  });

  if (articles.length === 0) {
    const extracted = extractEmbeddedArticles($, source.url);
    if (extracted.length > 0) {
      console.log(`[fetch] Selector found nothing, extracted ${extracted.length} articles from embedded JSON`);
      articles.push(...extracted);
    }
  }

  return articles;
}

function extractEmbeddedArticles($: cheerio.CheerioAPI, baseUrl: string): RawArticle[] {
  const results: RawArticle[] = [];
  const seen = new Set<string>();

  function addArticle(url: string | undefined | null, title: unknown, published_at: string | null = null) {
    if (!url || !title || seen.has(url)) return;
    seen.add(url);
    const absoluteUrl = url.startsWith('http') ? url : new URL(url, baseUrl).href;
    results.push({ url: absoluteUrl, title: String(title).trim(), published_at, image_url: null });
  }

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text()) as Record<string, unknown>;
      const items = Array.isArray(data) ? data : [data];
      for (const item of items as Record<string, unknown>[]) {
        const entries = (item['@graph'] as unknown[] ?? (Array.isArray(item.itemListElement) ? item.itemListElement as unknown[] : [item]));
        for (const entry of entries as Record<string, unknown>[]) {
          const type = entry['@type'];
          if (type === 'Article' || type === 'BlogPosting' || type === 'NewsArticle') {
            addArticle(entry.url as string, entry.headline ?? entry.name, (entry.datePublished as string) ?? null);
          }
          if (type === 'ListItem' && entry.item) {
            const i = entry.item as Record<string, unknown>;
            addArticle((i.url ?? i['@id']) as string, i.name ?? entry.name);
          }
        }
      }
    } catch { /* skip malformed JSON-LD */ }
  });

  if (results.length > 0) return results;

  const nextDataEl = $('script#__NEXT_DATA__');
  if (nextDataEl.length) {
    try {
      const nextData = JSON.parse(nextDataEl.text()) as Record<string, unknown>;
      function walk(obj: unknown, depth = 0): void {
        if (depth > 8 || !obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
          for (const item of obj as Record<string, unknown>[]) {
            if (item && typeof item === 'object' && (item.title || item.headline || item.name) && (item.url || item.slug || item.href || item.path)) {
              const url = (item.url ?? item.href ?? item.path ?? (item.slug ? new URL(String(item.slug), baseUrl).href : null)) as string | null;
              addArticle(url, item.title ?? item.headline ?? item.name, (item.date ?? item.publishedAt ?? item.datePublished) as string ?? null);
            } else {
              walk(item, depth + 1);
            }
          }
        } else {
          for (const val of Object.values(obj as object)) walk(val, depth + 1);
        }
      }
      walk((nextData?.props as Record<string, unknown>)?.pageProps);
    } catch { /* skip malformed __NEXT_DATA__ */ }
  }

  return results;
}

async function fetchArticlePage(url: string): Promise<{ content: string; image_url: string | null }> {
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    let image_url: string | null = $('meta[property="og:image"]').attr('content')
      ?? $('meta[name="twitter:image"]').attr('content')
      ?? null;

    if (!image_url) {
      $('script, style, svg, noscript, nav, header, footer').remove();
      const main = $('main, [role="main"], article').first();
      const contentEl = main.length ? main : $('body');
      contentEl.find('img').each((_, img) => {
        const src = $(img).attr('src');
        if (src && !src.startsWith('data:') && src.includes('.')) {
          image_url = src.startsWith('http') ? src : new URL(src, url).href;
          return false;
        }
      });
    }

    $('script, style, svg, noscript, nav, header, footer').remove();
    const main = $('main, [role="main"], article').first();
    const el = main.length ? main : $('body');
    const content = el.text().replace(/\s+/g, ' ').trim().slice(0, 5000);

    return { content, image_url };
  } catch {
    return { content: '', image_url: null };
  }
}

function isTooOld(published_at: string | null, max_age_days: number): boolean {
  if (!published_at) return false;
  const cutoff = Date.now() - max_age_days * 24 * 60 * 60 * 1000;
  return new Date(published_at).getTime() < cutoff;
}

async function gatherNewArticles(source: Source): Promise<PendingArticle[]> {
  const articles = source.fetch_type === 'rss'
    ? await fetchRssArticles(source)
    : await fetchHtmlArticles(source);

  console.log(`[fetch] Found ${articles.length} articles from ${source.name}`);
  const pending: PendingArticle[] = [];
  const seenUrls = new Set<string>();

  for (const article of articles) {
    if (!article.url) { console.log(`[fetch] Skipping article with no URL: "${article.title?.slice(0, 60)}"`); continue; }
    if (seenUrls.has(article.url)) continue;
    if (articleExistsByUrl(source.id, article.url)) continue;
    seenUrls.add(article.url);
    if (isTooOld(article.published_at, source.max_age_days ?? 7)) {
      console.log(`[fetch] Skipping old article: "${article.title?.slice(0, 60)}"`);
      continue;
    }

    const { content, image_url: pageImage } = await fetchArticlePage(article.url);
    const image_url = article.image_url ?? pageImage;
    console.log(`[fetch] Fetched content (${content.length} chars, image: ${!!image_url}): "${article.title?.slice(0, 60)}"`);
    pending.push({ source, article, content, image_url });
  }

  return pending;
}

async function classifyAndInsert(pending: PendingArticle[], userId: number | null): Promise<number> {
  if (pending.length === 0) return 0;

  const { results, _log } = await summarizeArticles(
    pending.map(p => ({ title: p.article.title, content: p.content })),
    userId
  );

  for (let i = 0; i < pending.length; i++) {
    const { source, article, image_url } = pending[i];
    const result = results[i] ?? {};
    insertArticle({
      source_id: source.id,
      url: article.url,
      title: article.title,
      summary: result.summary ?? null,
      image_url: image_url ?? null,
      published_at: article.published_at,
      is_relevant: result.is_relevant === false ? 0 : 1,
      relevance_reason: result.is_relevant === false ? (result.reason ?? null) : null,
      analysis_notes: _log ? JSON.stringify({ ..._log, parsed: result }) : null,
    });
  }

  console.log(`[fetch] Classified and stored ${pending.length} articles`);
  return pending.length;
}

export async function fetchAllSources(): Promise<{ totalNew: number }> {
  const sources = getActiveSources();
  const pendingByUser: Record<string, PendingArticle[]> = {};
  let totalNew = 0;

  for (const source of sources) {
    const uid = source.user_id != null ? String(source.user_id) : 'anon';
    if (!(uid in pendingByUser)) pendingByUser[uid] = [];
    try {
      console.log(`[fetch] Gathering from: ${source.name ?? source.url}`);
      pendingByUser[uid].push(...await gatherNewArticles(source));
    } catch (err) {
      console.error(`[fetch] Failed to gather from ${source.name ?? source.url}:`, (err as Error).message);
    }
  }

  for (const [uid, pending] of Object.entries(pendingByUser)) {
    const userId = uid === 'anon' ? null : Number(uid);
    if (pending.length === 0) {
      if (userId != null) {
        warmClassifyCache(userId).catch(err =>
          console.error(`[fetch] Cache warmup failed for user ${uid}:`, (err as Error).message)
        );
      }
      continue;
    }
    try {
      totalNew += await classifyAndInsert(pending, userId);
    } catch (err) {
      console.error(`[fetch] Batch classify failed for user ${uid}:`, (err as Error).message);
      for (const { source, article, image_url } of pending) {
        insertArticle({
          source_id: source.id,
          url: article.url,
          title: article.title,
          summary: null,
          image_url: image_url ?? null,
          published_at: article.published_at,
          is_relevant: 1,
          relevance_reason: null,
          analysis_notes: null,
        });
        totalNew++;
      }
    }
  }

  console.log(`[fetch] Cycle complete. ${totalNew} new articles.`);
  return { totalNew };
}

export async function fetchSource(id: number): Promise<{ totalNew: number }> {
  const source = getSourceById(id);
  if (!source) throw new Error(`Source ${id} not found`);
  console.log(`[fetch] Processing source: ${source.name ?? source.url}`);
  const pending = await gatherNewArticles(source);
  const newCount = await classifyAndInsert(pending, source.user_id);
  console.log(`[fetch] Done. ${newCount} new articles.`);
  return { totalNew: newCount };
}

async function validateFeed(feedUrl: string): Promise<string | null> {
  try {
    const feed = await rssParser.parseURL(feedUrl);
    return (feed.items?.length ?? 0) > 0 ? feedUrl : null;
  } catch {
    return null;
  }
}

export async function detectSourceConfig(url: string, userId: number | null = null) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const name = $('title').first().text().trim() || new URL(url).hostname;

  const linkCandidates: string[] = [];
  $('link[rel="alternate"]').each((_, el) => {
    const type = $(el).attr('type') ?? '';
    if (type.includes('rss') || type.includes('atom')) {
      const href = $(el).attr('href');
      if (href) linkCandidates.push(href.startsWith('http') ? href : new URL(href, url).href);
    }
  });

  for (const feedUrl of linkCandidates) {
    const valid = await validateFeed(feedUrl);
    if (valid) {
      console.log(`[source] Valid RSS from page link: ${valid}`);
      return { has_rss: true, feed_url: valid, selector: null, date_selector: null, image_selector: null, name, _log: null };
    }
  }

  console.log(`[source] No valid RSS found, using HTML scraping for ${url}`);
  return analyzeSource(url, html, userId);
}

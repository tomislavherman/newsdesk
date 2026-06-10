import { fetch } from 'undici';
import * as cheerio from 'cheerio';
import RSSParser from 'rss-parser';
import { getActiveSources, getSourceById, articleExistsByUrl, insertArticle } from './db.js';
import { analyzeSource, summarizeArticles, warmClassifyCache } from './ai.js';

const rssParser = new RSSParser({
  customFields: {
    item: [
      ['media:content', 'mediaContent'],
      ['media:thumbnail', 'mediaThumbnail'],
      ['enclosure', 'enclosure'],
      ['content:encoded', 'content:encoded'],
    ],
  },
});

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Newsdesk/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function parseDate(text) {
  if (!text) return null;
  const d = new Date(text.trim());
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function extractRssImage(item) {
  // Standard media elements
  if (item.enclosure?.url && item.enclosure.type?.startsWith('image/')) return item.enclosure.url;
  const mc = item.mediaContent;
  if (mc) {
    const url = mc?.$ ? mc.$.url : (Array.isArray(mc) ? mc[0]?.$.url : null);
    if (url) return url;
  }
  const mt = item.mediaThumbnail;
  if (mt) {
    const url = mt?.$ ? mt.$.url : (Array.isArray(mt) ? mt[0]?.$.url : null);
    if (url) return url;
  }
  // Fall back to first <img src> in content HTML (e.g. GitHub blog embeds images in content:encoded)
  const contentHtml = item['content:encoded'] ?? item.content ?? '';
  if (contentHtml) {
    const match = contentHtml.match(/<img[^>]+src="([^"]+)"/i);
    if (match?.[1] && !match[1].startsWith('data:')) {
      // Strip resize query params, keep the base URL
      return match[1].split('?')[0];
    }
  }
  return null;
}

async function fetchRssArticles(source) {
  let feed;
  try {
    feed = await rssParser.parseURL(source.feed_url);
  } catch (err) {
    console.error(`[fetch] RSS parse failed for ${source.feed_url}: ${err.message}`);
    return [];
  }
  return feed.items.map(item => ({
    url: item.link,
    title: item.title,
    image_url: extractRssImage(item),
    published_at: item.pubDate ? new Date(item.pubDate).toISOString() : null,
  }));
}

async function fetchHtmlArticles(source) {
  const html = await fetchHtml(source.url);
  const $ = cheerio.load(html);
  const articles = [];

  const sourceHost = new URL(source.url).hostname;

  $(source.selector).each((_, el) => {
    const $el = $(el);

    // Score each link: longest text wins (titles >> nav/action links).
    // Small bonus for external links to break ties between equally long texts.
    let bestLink = null;
    let bestScore = -1;
    $el.find('a[href]').each((_, a) => {
      const $a = $(a);
      const text = $a.text().trim();
      if (text.length < 4) return; // skip icon-only or very short links
      let score = text.length;
      try {
        const href = $a.attr('href') ?? '';
        if (href.startsWith('http') && new URL(href).hostname !== sourceHost) score += 20;
      } catch {}
      if (score > bestScore) { bestScore = score; bestLink = $a; }
    });
    const link = bestLink ?? $el.find('a[href]').first();

    const url = link?.attr('href');
    if (!url) return;

    const absoluteUrl = url.startsWith('http') ? url : new URL(url, source.url).href;

    let published_at = null;
    if (source.date_selector) {
      published_at = parseDate($el.find(source.date_selector).first().text());
    }

    let image_url = null;
    if (source.image_selector) {
      const img = $el.find(source.image_selector).first();
      const src = img.attr('src') ?? img.attr('data-src') ?? img.attr('data-lazy-src');
      if (src) image_url = src.startsWith('http') ? src : new URL(src, source.url).href;
    }

    const rawTitle = link.text().trim() || $el.text().trim();
    // Strip leading rank numbers like "28. " or "1) "
    const title = rawTitle.replace(/^\d+[.)]\s*/, '').trim();
    articles.push({ url: absoluteUrl, title, published_at, image_url });
  });

  // Fallback for JS-rendered pages (e.g. Next.js SPAs): try to extract articles
  // from embedded JSON data when the selector matched nothing.
  if (articles.length === 0) {
    const extracted = extractEmbeddedArticles($, source.url);
    if (extracted.length > 0) {
      console.log(`[fetch] Selector found nothing, extracted ${extracted.length} articles from embedded JSON`);
      articles.push(...extracted);
    }
  }

  return articles;
}

function extractEmbeddedArticles($, baseUrl) {
  const results = [];
  const seen = new Set();

  function addArticle(url, title, published_at = null) {
    if (!url || !title || seen.has(url)) return;
    seen.add(url);
    const absoluteUrl = url.startsWith('http') ? url : new URL(url, baseUrl).href;
    results.push({ url: absoluteUrl, title: String(title).trim(), published_at, image_url: null });
  }

  // 1. JSON-LD structured data
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const entries = item['@graph'] ?? (Array.isArray(item.itemListElement) ? item.itemListElement : [item]);
        for (const entry of entries) {
          const type = entry['@type'];
          if (type === 'Article' || type === 'BlogPosting' || type === 'NewsArticle') {
            addArticle(entry.url, entry.headline ?? entry.name, entry.datePublished ?? null);
          }
          if (type === 'ListItem' && entry.item) {
            addArticle(entry.item.url ?? entry.item['@id'], entry.item.name ?? entry.name);
          }
        }
      }
    } catch {}
  });

  if (results.length > 0) return results;

  // 2. Next.js __NEXT_DATA__
  const nextDataEl = $('script#__NEXT_DATA__');
  if (nextDataEl.length) {
    try {
      const nextData = JSON.parse(nextDataEl.text());
      // Walk the props tree looking for arrays of objects with url/title/slug fields
      function walk(obj, depth = 0) {
        if (depth > 8 || !obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
          for (const item of obj) {
            if (item && typeof item === 'object' && (item.title || item.headline || item.name) && (item.url || item.slug || item.href || item.path)) {
              const url = item.url ?? item.href ?? item.path ?? (item.slug ? new URL(item.slug, baseUrl).href : null);
              addArticle(url, item.title ?? item.headline ?? item.name, item.date ?? item.publishedAt ?? item.datePublished ?? null);
            } else {
              walk(item, depth + 1);
            }
          }
        } else {
          for (const val of Object.values(obj)) walk(val, depth + 1);
        }
      }
      walk(nextData?.props?.pageProps);
    } catch {}
  }

  return results;
}

async function fetchArticlePage(url) {
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    // Extract image: prefer og:image, fall back to first meaningful img in content
    let image_url = $('meta[property="og:image"]').attr('content')
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
          return false; // break
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

function isTooOld(published_at, max_age_days) {
  if (!published_at) return false; // no date = let it through
  const cutoff = Date.now() - max_age_days * 24 * 60 * 60 * 1000;
  return new Date(published_at).getTime() < cutoff;
}

async function gatherNewArticles(source) {
  const articles = source.fetch_type === 'rss'
    ? await fetchRssArticles(source)
    : await fetchHtmlArticles(source);

  console.log(`[fetch] Found ${articles.length} articles from ${source.name}`);
  const pending = [];

  const seenUrls = new Set();
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

async function classifyAndInsert(pending, userId) {
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

export async function fetchAllSources() {
  const sources = getActiveSources();
  const pendingByUser = {};
  let totalNew = 0;

  // Phase 1: gather new articles across all sources
  for (const source of sources) {
    const uid = source.user_id ?? 'anon';
    if (!(uid in pendingByUser)) pendingByUser[uid] = [];
    try {
      console.log(`[fetch] Gathering from: ${source.name ?? source.url}`);
      pendingByUser[uid].push(...await gatherNewArticles(source));
    } catch (err) {
      console.error(`[fetch] Failed to gather from ${source.name ?? source.url}:`, err.message);
    }
  }

  // Phase 2: classify per user in one batch each
  for (const [uid, pending] of Object.entries(pendingByUser)) {
    const userId = uid === 'anon' ? null : Number(uid);
    if (pending.length === 0) {
      if (userId != null) {
        warmClassifyCache(userId).catch(err =>
          console.error(`[fetch] Cache warmup failed for user ${uid}:`, err.message)
        );
      }
      continue;
    }
    try {
      totalNew += await classifyAndInsert(pending, userId);
    } catch (err) {
      console.error(`[fetch] Batch classify failed for user ${uid}:`, err.message);
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

export async function fetchSource(id) {
  const source = getSourceById(id);
  if (!source) throw new Error(`Source ${id} not found`);
  console.log(`[fetch] Processing source: ${source.name ?? source.url}`);
  const pending = await gatherNewArticles(source);
  const newCount = await classifyAndInsert(pending, source.user_id);
  console.log(`[fetch] Done. ${newCount} new articles.`);
  return { totalNew: newCount };
}

async function validateFeed(feedUrl) {
  try {
    const feed = await rssParser.parseURL(feedUrl);
    return feed.items?.length > 0 ? feedUrl : null;
  } catch {
    return null;
  }
}

export async function detectSourceConfig(url, userId = null) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const name = $('title').first().text().trim() || new URL(url).hostname;

  // 1. Try <link rel="alternate"> RSS/Atom tags from the page head
  const linkCandidates = [];
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

  // 2. Fall back to Claude HTML selector detection
  console.log(`[source] No valid RSS found, using HTML scraping for ${url}`);
  return analyzeSource(url, html, userId);
}

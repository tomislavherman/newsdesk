import { fetch } from 'undici';
import * as cheerio from 'cheerio';
import RSSParser from 'rss-parser';
import { getActiveSources, getSourceById, articleExistsByUrl, insertArticle } from './db.js';
import { analyzeSource, summarizeArticle } from './ai.js';

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

  return articles;
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

async function processSource(source) {
  const articles = source.fetch_type === 'rss'
    ? await fetchRssArticles(source)
    : await fetchHtmlArticles(source);

  console.log(`[fetch] Found ${articles.length} articles from ${source.name}`);
  let newCount = 0;

  for (const article of articles) {
    if (!article.url || articleExistsByUrl(article.url)) continue;

    if (isTooOld(article.published_at, source.max_age_days ?? 7)) {
      console.log(`[fetch] Skipping old article: "${article.title?.slice(0, 60)}"`);
      continue;
    }

    try {
      const { content, image_url: pageImage } = await fetchArticlePage(article.url);
      const image_url = article.image_url ?? pageImage;
      console.log(`[fetch] Fetched content (${content.length} chars, image: ${!!image_url}): "${article.title?.slice(0, 60)}"`);
      const result = await summarizeArticle(article.title, content, source.user_id);
      insertArticle({
        source_id: source.id,
        url: article.url,
        title: article.title,
        summary: result.summary ?? null,
        image_url: image_url ?? null,
        published_at: article.published_at,
        is_relevant: result.is_relevant === false ? 0 : 1,
        relevance_reason: result.is_relevant === false ? (result.reason ?? null) : null,
        analysis_notes: result._log ? JSON.stringify(result._log) : null,
      });
      newCount++;
    } catch (err) {
      console.error(`[fetch] Failed to process "${article.title}":`, err.message);
      insertArticle({
        source_id: source.id,
        url: article.url,
        title: article.title,
        summary: null,
        image_url: article.image_url ?? null,
        published_at: article.published_at,
        is_relevant: 1,
        relevance_reason: null,
        analysis_notes: null,
      });
      newCount++;
    }
  }

  console.log(`[fetch] Stored ${newCount} new articles from ${source.name}`);
  return newCount;
}

export async function fetchAllSources() {
  const sources = getActiveSources();
  let totalNew = 0;
  for (const source of sources) {
    try {
      console.log(`[fetch] Processing source: ${source.name ?? source.url}`);
      totalNew += await processSource(source);
    } catch (err) {
      console.error(`[fetch] Failed to fetch source ${source.name ?? source.url}:`, err.message);
    }
  }
  console.log(`[fetch] Cycle complete. ${totalNew} new articles.`);
  return { totalNew };
}

export async function fetchSource(id) {
  const source = getSourceById(id);
  if (!source) throw new Error(`Source ${id} not found`);
  console.log(`[fetch] Processing source: ${source.name ?? source.url}`);
  const newCount = await processSource(source);
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

export async function detectSourceConfig(url) {
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
  return analyzeSource(url, html);
}

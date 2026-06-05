import { fetch } from 'undici';
import * as cheerio from 'cheerio';
import RSSParser from 'rss-parser';
import { getActiveSources, articleExistsByUrl, insertArticle } from './db.js';
import { analyzeSource, classifyArticle } from './ai.js';

const rssParser = new RSSParser();

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Newsdesk/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchRssArticles(source) {
  const feed = await rssParser.parseURL(source.feed_url);
  return feed.items.map(item => ({
    url: item.link,
    title: item.title,
    content: item.contentSnippet ?? item.content ?? '',
    published_at: item.pubDate ? new Date(item.pubDate).toISOString() : null,
  }));
}

async function fetchHtmlArticles(source) {
  const html = await fetchHtml(source.url);
  const $ = cheerio.load(html);
  const articles = [];

  $(source.selector).each((_, el) => {
    const $el = $(el);
    const link = $el.find('a').first();
    const url = link.attr('href');
    if (!url) return;

    const absoluteUrl = url.startsWith('http') ? url : new URL(url, source.url).href;
    articles.push({
      url: absoluteUrl,
      title: link.text().trim() || $el.text().trim(),
      content: $el.text().trim(),
      published_at: null,
    });
  });

  return articles;
}

export async function fetchAllSources() {
  const sources = getActiveSources();
  let totalNew = 0;
  let totalRelevant = 0;

  for (const source of sources) {
    try {
      console.log(`[fetch] Processing source: ${source.name ?? source.url}`);
      const articles = source.fetch_type === 'rss'
        ? await fetchRssArticles(source)
        : await fetchHtmlArticles(source);

      console.log(`[fetch] Found ${articles.length} articles from ${source.name}`);
      let newCount = 0;

      for (const article of articles) {
        if (!article.url || articleExistsByUrl(article.url)) continue;

        try {
          const classification = await classifyArticle(article.title, article.content);
          insertArticle({
            source_id: source.id,
            url: article.url,
            title: article.title,
            summary: classification.summary ?? null,
            published_at: article.published_at,
            is_relevant: classification.is_relevant ? 1 : 0,
            relevance_reason: classification.reason ?? null,
          });
          newCount++;
          if (classification.is_relevant) totalRelevant++;
        } catch (err) {
          console.error(`[fetch] Failed to classify article "${article.title}":`, err.message);
        }
      }

      totalNew += newCount;
      console.log(`[fetch] Stored ${newCount} new articles from ${source.name}`);
    } catch (err) {
      console.error(`[fetch] Failed to fetch source ${source.name ?? source.url}:`, err.message);
    }
  }

  console.log(`[fetch] Cycle complete. ${totalNew} new articles, ${totalRelevant} relevant.`);
  return { totalNew, totalRelevant };
}

export async function detectSourceConfig(url) {
  const html = await fetchHtml(url);
  return analyzeSource(url, html);
}

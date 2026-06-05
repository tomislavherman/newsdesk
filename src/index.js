import Fastify from 'fastify';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import {
  getSources, insertSource, updateSourceActive, updateSource, deleteSource, deleteAllSources, getSourceById,
  getArticles, getUnseenCount, markArticleSeen, markArticleUnseen, markAllSeen,
  dismissArticle, restoreArticle, deleteAllArticles, insertFeedback,
} from './db.js';
import { fetchAllSources, fetchSource, detectSourceConfig } from './fetcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const fastify = Fastify({ logger: true });

await fastify.register((await import('@fastify/static')).default, {
  root: join(__dirname, '..', 'public'),
});

const ADMIN_MODE = !!process.env.ADMIN_MODE;

fastify.get('/api/config', async () => ({ adminMode: ADMIN_MODE }));

// Articles
fastify.get('/api/articles', async (req) => {
  const { limit = 50, offset = 0, read = 'all', relevance = 'all' } = req.query;
  return getArticles({ limit: Number(limit), offset: Number(offset), read, relevance });
});

fastify.get('/api/articles/unseen-count', async () => {
  return getUnseenCount();
});

fastify.post('/api/articles/:id/seen', async (req) => {
  markArticleSeen(Number(req.params.id));
  return { ok: true };
});

fastify.post('/api/articles/:id/unseen', async (req) => {
  markArticleUnseen(Number(req.params.id));
  return { ok: true };
});

fastify.post('/api/articles/seen-all', async () => {
  markAllSeen();
  return { ok: true };
});

fastify.delete('/api/articles', async () => {
  deleteAllArticles();
  return { ok: true };
});

fastify.post('/api/articles/:id/feedback', async (req) => {
  const id = Number(req.params.id);
  const { reason } = req.body ?? {};
  dismissArticle(id);
  insertFeedback(id, reason);
  return { ok: true };
});

fastify.post('/api/articles/:id/restore', async (req) => {
  restoreArticle(Number(req.params.id));
  return { ok: true };
});

// Sources
fastify.get('/api/sources', async () => {
  return getSources();
});

fastify.post('/api/sources/analyze', async (req) => {
  const { url } = req.body;
  if (!url) throw fastify.httpErrors.badRequest('url is required');
  return detectSourceConfig(url);
});

fastify.post('/api/sources', async (req) => {
  const { url, name, feed_url, selector, date_selector, image_selector, fetch_type, max_age_days, color, analysis_notes } = req.body;
  if (!url || !fetch_type) throw fastify.httpErrors.badRequest('url and fetch_type are required');
  const result = insertSource({
    url, name,
    feed_url: feed_url ?? null,
    selector: selector ?? null,
    date_selector: date_selector ?? null,
    image_selector: image_selector ?? null,
    fetch_type,
    max_age_days: max_age_days ?? 7,
    color: color ?? null,
    analysis_notes: analysis_notes ?? null,
  });
  const id = result.lastInsertRowid;
  fetchSource(id).catch(err => fastify.log.error(err));
  return { id };
});

fastify.post('/api/sources/:id/fetch', async (req) => {
  fetchSource(Number(req.params.id)).catch(err => fastify.log.error(err));
  return { ok: true };
});

fastify.patch('/api/sources/:id', async (req) => {
  const id = Number(req.params.id);
  const { active, name, feed_url, selector, date_selector, image_selector, fetch_type, max_age_days, color } = req.body;
  if (active !== undefined) {
    updateSourceActive(id, active);
  } else {
    updateSource(id, { name, feed_url: feed_url ?? null, selector: selector ?? null, date_selector: date_selector ?? null, image_selector: image_selector ?? null, fetch_type, max_age_days: max_age_days ?? 7, color: color ?? null });
  }
  return { ok: true };
});

fastify.delete('/api/sources', async () => {
  deleteAllSources();
  return { ok: true };
});

fastify.delete('/api/sources/:id', async (req) => {
  deleteSource(Number(req.params.id));
  return { ok: true };
});

// Manual fetch trigger
fastify.post('/api/fetch', async () => {
  fetchAllSources().catch(err => fastify.log.error(err));
  return { ok: true, message: 'Fetch cycle started in background' };
});

// Cron: fetch every hour
cron.schedule('0 * * * *', () => {
  fastify.log.info('Cron: starting scheduled fetch');
  fetchAllSources().catch(err => fastify.log.error(err));
});

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);

await fastify.listen({ host, port });
console.log(`Newsdesk running at http://${host}:${port}`);

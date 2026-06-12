import Fastify from 'fastify';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schedule } from 'node-cron';
import {
  getUserCount, getUserByUsername, getUserById, createUser, getUsers, updateUser, claimOrphanedSources,
  createSession, getUserByToken, deleteSession,
  getSetting, setSetting,
  getSources, insertSource, updateSourceActive, updateSource, deleteSource, deleteAllSources,
  getAllSourcesAdmin, getAllArticlesAdmin,
  getArticles, getUnseenCount, markArticleSeen, markArticleUnseen, markAllSeen,
  dismissArticle, restoreArticle, deleteAllArticles, insertFeedback,
} from './db.js';
import { hashPassword, verifyPassword, generateToken } from './auth.js';
import { fetchAllSources, fetchSource, detectSourceConfig } from './fetcher.js';
import posthog from './posthog.js';
import type { User } from './types.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const fastify = Fastify({ logger: true });

await fastify.register((await import('@fastify/static')).default, {
  root: join(__dirname, '..', 'public'),
});
await fastify.register((await import('@fastify/cookie')).default);

// ── Auth middleware ────────────────────────────────────────────────────────────

const PUBLIC_PATHS = new Set(['/api/auth/login', '/api/auth/signup', '/api/auth/me']);

fastify.addHook('preHandler', async (req, reply) => {
  if (!req.url.startsWith('/api/')) return;
  const path = req.url.split('?')[0];
  if (PUBLIC_PATHS.has(path)) return;

  const token = req.cookies?.session;
  const user = token ? getUserByToken(token) : null;
  if (!user || !user.approved || user.blocked) return reply.code(401).send({ error: 'Unauthorized' });

  req.user = user;

  if (path.startsWith('/api/admin') && user.role !== 'admin') {
    return reply.code(403).send({ error: 'Forbidden' });
  }
});

// ── Auth routes ────────────────────────────────────────────────────────────────

fastify.get('/api/auth/me', async (req) => {
  const token = req.cookies?.session;
  if (!token) return { user: null };
  const user = getUserByToken(token);
  if (!user) return { user: null };
  const { password_hash: _, ...safe } = user;
  return { user: safe };
});

fastify.post('/api/auth/signup', async (req, reply) => {
  const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
  if (!username || !password) return reply.code(400).send({ error: 'Username and password required' });
  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) return reply.code(400).send({ error: 'Username must be 3-32 alphanumeric characters' });
  if (password.length < 6) return reply.code(400).send({ error: 'Password must be at least 6 characters' });
  if (getUserByUsername(username)) return reply.code(409).send({ error: 'Username already taken' });

  const isFirst = getUserCount() === 0;
  const autoApprove = getSetting('auto_approve', 'false') === 'true';
  const role = isFirst ? 'admin' : 'user';
  const approved = isFirst || autoApprove;

  const password_hash = await hashPassword(password);
  const result = createUser({ username, password_hash, role, approved });
  const userId = Number(result.lastInsertRowid);

  if (isFirst) claimOrphanedSources(userId);

  posthog.capture({
    distinctId: String(userId),
    event: 'user signed up',
    properties: { role, approved, is_first_user: isFirst },
  });

  if (approved) {
    posthog.identify({ distinctId: String(userId), properties: { username, role } });
    const token = generateToken();
    createSession(token, userId);
    reply.setCookie('session', token, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 30 * 24 * 3600 });
    const user = getUserById(userId);
    if (!user) return reply.code(500).send({ error: 'Failed to create user' });
    const { password_hash: _, ...safe } = user;
    return { user: safe };
  }

  return { user: null, pending: true };
});

fastify.post('/api/auth/login', async (req, reply) => {
  const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
  if (!username || !password) return reply.code(400).send({ error: 'Username and password required' });

  const user = getUserByUsername(username);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return reply.code(401).send({ error: 'Invalid username or password' });
  }
  if (user.blocked) return reply.code(403).send({ error: 'Account has been blocked' });
  if (!user.approved) return reply.code(403).send({ error: 'Account pending approval' });

  posthog.identify({ distinctId: String(user.id), properties: { username: user.username, role: user.role } });
  posthog.capture({ distinctId: String(user.id), event: 'user logged in' });
  const token = generateToken();
  createSession(token, user.id);
  reply.setCookie('session', token, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 30 * 24 * 3600 });
  const { password_hash, ...safe } = user;
  return { user: safe };
});

fastify.post('/api/auth/logout', async (req, reply) => {
  const token = req.cookies?.session;
  if (token) deleteSession(token);
  reply.clearCookie('session', { path: '/' });
  return { ok: true };
});

// ── Admin routes ───────────────────────────────────────────────────────────────

fastify.get('/api/admin/users', async () => getUsers());

fastify.patch('/api/admin/users/:id', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  if (id === req.user!.id) return reply.code(400).send({ error: 'Cannot modify your own role' });
  const { role, approved, blocked } = (req.body ?? {}) as { role?: string; approved?: number; blocked?: number };
  const target = getUserById(id);
  if (!target) return reply.code(404).send({ error: 'User not found' });
  updateUser(id, {
    role: role ?? target.role,
    approved: approved !== undefined ? approved : target.approved,
    blocked: blocked !== undefined ? blocked : target.blocked,
  });
  return { ok: true };
});

fastify.get('/api/admin/sources', async () => getAllSourcesAdmin());

fastify.get('/api/admin/articles', async (req) => {
  const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 100), 500);
  return getAllArticlesAdmin(limit);
});

fastify.get('/api/admin/settings', async () => ({
  auto_approve: getSetting('auto_approve', 'false') === 'true',
}));

fastify.patch('/api/admin/settings', async (req) => {
  const { auto_approve } = (req.body ?? {}) as { auto_approve?: boolean };
  if (auto_approve !== undefined) setSetting('auto_approve', auto_approve ? 'true' : 'false');
  return { ok: true };
});

// ── Articles ───────────────────────────────────────────────────────────────────

fastify.get('/api/articles', async (req) => {
  const { limit = '20', offset = '0', read = 'all', relevance = 'all' } = req.query as Record<string, string>;
  return getArticles({ userId: req.user!.id, limit: Number(limit), offset: Number(offset), read, relevance });
});

fastify.get('/api/articles/unseen-count', async (req) => getUnseenCount(req.user!.id));

fastify.post('/api/articles/:id/seen', async (req) => {
  markArticleSeen(Number((req.params as { id: string }).id), req.user!.id);
  return { ok: true };
});

fastify.post('/api/articles/:id/unseen', async (req) => {
  markArticleUnseen(Number((req.params as { id: string }).id), req.user!.id);
  return { ok: true };
});

fastify.post('/api/articles/seen-all', async (req) => {
  markAllSeen(req.user!.id);
  return { ok: true };
});

fastify.post('/api/articles/:id/feedback', async (req) => {
  const id = Number((req.params as { id: string }).id);
  const body = (req.body ?? {}) as { reason?: string };
  dismissArticle(id, req.user!.id);
  insertFeedback(id, body.reason);
  posthog.capture({
    distinctId: String(req.user!.id),
    event: 'article dismissed',
    properties: { article_id: id, has_reason: !!body.reason },
  });
  return { ok: true };
});

fastify.post('/api/articles/:id/restore', async (req) => {
  restoreArticle(Number((req.params as { id: string }).id), req.user!.id);
  return { ok: true };
});

fastify.delete('/api/articles', async (req) => {
  deleteAllArticles(req.user!.id);
  posthog.capture({ distinctId: String(req.user!.id), event: 'articles wiped' });
  return { ok: true };
});

// ── Sources ────────────────────────────────────────────────────────────────────

fastify.get('/api/sources', async (req) => getSources(req.user!.id));

fastify.post('/api/sources/analyze', async (req, reply) => {
  const { url } = (req.body ?? {}) as { url?: string };
  if (!url) return reply.code(400).send({ error: 'url is required' });
  return detectSourceConfig(url, req.user!.id);
});

fastify.post('/api/sources', async (req, reply) => {
  const {
    url, name, feed_url, selector, date_selector, image_selector,
    fetch_type, max_age_days, color, analysis_notes,
  } = (req.body ?? {}) as {
    url: string; name: string | null; feed_url?: string | null; selector?: string | null;
    date_selector?: string | null; image_selector?: string | null; fetch_type: 'rss' | 'html';
    max_age_days?: number; color?: string | null; analysis_notes?: string | null;
  };
  try {
    const result = insertSource({
      user_id: req.user!.id, url, name: name ?? null,
      feed_url: feed_url ?? null, selector: selector ?? null,
      date_selector: date_selector ?? null, image_selector: image_selector ?? null,
      fetch_type, max_age_days: max_age_days ?? 1,
      color: color ?? null, analysis_notes: analysis_notes ?? null,
    });
    const id = Number(result.lastInsertRowid);
    fetchSource(id).catch(err => fastify.log.error(err));
    posthog.capture({
      distinctId: String(req.user!.id),
      event: 'source added',
      properties: { source_name: name, fetch_type, has_feed_url: !!feed_url },
    });
    return { id };
  } catch (err) {
    if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return reply.code(409).send({ error: 'This source has already been added' });
    }
    throw err;
  }
});

fastify.post('/api/sources/:id/fetch', async (req) => {
  fetchSource(Number((req.params as { id: string }).id)).catch(err => fastify.log.error(err));
  return { ok: true };
});

fastify.patch('/api/sources/:id', async (req) => {
  const id = Number((req.params as { id: string }).id);
  const { active, name, feed_url, selector, date_selector, image_selector, fetch_type, max_age_days, color } = (req.body ?? {}) as {
    active?: boolean; name?: string | null; feed_url?: string | null; selector?: string | null;
    date_selector?: string | null; image_selector?: string | null; fetch_type?: 'rss' | 'html';
    max_age_days?: number; color?: string | null;
  };
  if (active !== undefined) {
    updateSourceActive(id, req.user!.id, active);
    posthog.capture({ distinctId: String(req.user!.id), event: 'source toggled', properties: { source_id: id, active } });
  } else {
    updateSource(id, req.user!.id, {
      name: name ?? null, feed_url: feed_url ?? null, selector: selector ?? null,
      date_selector: date_selector ?? null, image_selector: image_selector ?? null,
      fetch_type: fetch_type ?? 'html', max_age_days: max_age_days ?? 1, color: color ?? null,
    });
  }
  return { ok: true };
});

fastify.delete('/api/sources/:id', async (req) => {
  const sourceId = Number((req.params as { id: string }).id);
  deleteSource(sourceId, req.user!.id);
  posthog.capture({ distinctId: String(req.user!.id), event: 'source deleted', properties: { source_id: sourceId } });
  return { ok: true };
});

fastify.delete('/api/sources', async (req) => {
  deleteAllSources(req.user!.id);
  return { ok: true };
});

// ── Manual fetch (admin only) ──────────────────────────────────────────────────

fastify.post('/api/fetch', async (req, reply) => {
  if (req.user!.role !== 'admin') return reply.code(403).send({ error: 'Forbidden' });
  fetchAllSources().catch(err => fastify.log.error(err));
  posthog.capture({ distinctId: String(req.user!.id), event: 'fetch triggered' });
  return { ok: true };
});

// ── Error handling ─────────────────────────────────────────────────────────────

fastify.setErrorHandler((error, request, reply) => {
  const distinctId = request.user ? String(request.user.id) : 'anonymous';
  posthog.captureException(error, distinctId);
  reply.send(error);
});

process.on('SIGTERM', async () => { await posthog.shutdown(); process.exit(0); });
process.on('SIGINT', async () => { await posthog.shutdown(); process.exit(0); });

// ── Cron: fetch all sources every 10 minutes ───────────────────────────────────

schedule('*/10 * * * *', () => {
  fastify.log.info('Cron: starting scheduled fetch');
  fetchAllSources().catch(err => fastify.log.error(err));
});

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);
await fastify.listen({ host, port });
console.log(`Newsdesk running at http://${host}:${port}`);

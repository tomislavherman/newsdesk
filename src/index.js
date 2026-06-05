import Fastify from 'fastify';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import {
  getUserCount, getUserByUsername, getUserById, createUser, getUsers, updateUser, claimOrphanedSources,
  createSession, getUserByToken, deleteSession,
  getSetting, setSetting,
  getSources, insertSource, updateSourceActive, updateSource, deleteSource, deleteAllSources, getSourceById,
  getArticles, getUnseenCount, markArticleSeen, markArticleUnseen, markAllSeen,
  dismissArticle, restoreArticle, deleteAllArticles, insertFeedback,
} from './db.js';
import { hashPassword, verifyPassword, generateToken } from './auth.js';
import { fetchAllSources, fetchSource, detectSourceConfig } from './fetcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fastify = Fastify({ logger: true });

await fastify.register((await import('@fastify/static')).default, {
  root: join(__dirname, '..', 'public'),
});
await fastify.register((await import('@fastify/cookie')).default);

// ── Auth middleware ────────────────────────────────────────────────────────

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

// ── Auth routes ───────────────────────────────────────────────────────────

fastify.get('/api/auth/me', async (req) => {
  const token = req.cookies?.session;
  if (!token) return { user: null };
  const user = getUserByToken(token);
  if (!user) return { user: null };
  const { password_hash, ...safe } = user;
  return { user: safe };
});

fastify.post('/api/auth/signup', async (req, reply) => {
  const { username, password } = req.body ?? {};
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
  const userId = result.lastInsertRowid;

  if (isFirst) claimOrphanedSources(userId);

  if (approved) {
    const token = generateToken();
    createSession(token, userId);
    reply.setCookie('session', token, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 30 * 24 * 3600 });
    const user = getUserById(userId);
    const { password_hash: _, ...safe } = user;
    return { user: safe };
  }

  return { user: null, pending: true };
});

fastify.post('/api/auth/login', async (req, reply) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) return reply.code(400).send({ error: 'Username and password required' });

  const user = getUserByUsername(username);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return reply.code(401).send({ error: 'Invalid username or password' });
  }
  if (user.blocked) return reply.code(403).send({ error: 'Account has been blocked' });
  if (!user.approved) return reply.code(403).send({ error: 'Account pending approval' });

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

// ── Admin routes ──────────────────────────────────────────────────────────

fastify.get('/api/admin/users', async () => getUsers());

fastify.patch('/api/admin/users/:id', async (req, reply) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return reply.code(400).send({ error: 'Cannot modify your own role' });
  const { role, approved, blocked } = req.body;
  const target = getUserById(id);
  if (!target) return reply.code(404).send({ error: 'User not found' });
  updateUser(id, {
    role: role ?? target.role,
    approved: approved !== undefined ? approved : target.approved,
    blocked: blocked !== undefined ? blocked : target.blocked,
  });
  return { ok: true };
});

fastify.get('/api/admin/settings', async () => ({
  auto_approve: getSetting('auto_approve', 'false') === 'true',
}));

fastify.patch('/api/admin/settings', async (req) => {
  const { auto_approve } = req.body;
  if (auto_approve !== undefined) setSetting('auto_approve', auto_approve ? 'true' : 'false');
  return { ok: true };
});

// ── Articles ──────────────────────────────────────────────────────────────

fastify.get('/api/articles', async (req) => {
  const { limit = 20, offset = 0, read = 'all', relevance = 'all' } = req.query;
  return getArticles({ userId: req.user.id, limit: Number(limit), offset: Number(offset), read, relevance });
});

fastify.get('/api/articles/unseen-count', async (req) => getUnseenCount(req.user.id));

fastify.post('/api/articles/:id/seen', async (req) => {
  markArticleSeen(Number(req.params.id));
  return { ok: true };
});

fastify.post('/api/articles/:id/unseen', async (req) => {
  markArticleUnseen(Number(req.params.id));
  return { ok: true };
});

fastify.post('/api/articles/seen-all', async (req) => {
  markAllSeen(req.user.id);
  return { ok: true };
});

fastify.post('/api/articles/:id/feedback', async (req) => {
  const id = Number(req.params.id);
  dismissArticle(id);
  insertFeedback(id, req.body?.reason);
  return { ok: true };
});

fastify.post('/api/articles/:id/restore', async (req) => {
  restoreArticle(Number(req.params.id));
  return { ok: true };
});

fastify.delete('/api/articles', async (req) => {
  deleteAllArticles(req.user.id);
  return { ok: true };
});

// ── Sources ───────────────────────────────────────────────────────────────

fastify.get('/api/sources', async (req) => getSources(req.user.id));

fastify.post('/api/sources/analyze', async (req, reply) => {
  const { url } = req.body;
  if (!url) return reply.code(400).send({ error: 'url is required' });
  return detectSourceConfig(url);
});

fastify.post('/api/sources', async (req) => {
  const { url, name, feed_url, selector, date_selector, image_selector, fetch_type, max_age_days, color, analysis_notes } = req.body;
  const result = insertSource({
    user_id: req.user.id, url, name,
    feed_url: feed_url ?? null, selector: selector ?? null,
    date_selector: date_selector ?? null, image_selector: image_selector ?? null,
    fetch_type, max_age_days: max_age_days ?? 1,
    color: color ?? null, analysis_notes: analysis_notes ?? null,
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
    updateSource(id, { name, feed_url: feed_url ?? null, selector: selector ?? null, date_selector: date_selector ?? null, image_selector: image_selector ?? null, fetch_type, max_age_days: max_age_days ?? 1, color: color ?? null });
  }
  return { ok: true };
});

fastify.delete('/api/sources/:id', async (req) => {
  deleteSource(Number(req.params.id), req.user.id);
  return { ok: true };
});

fastify.delete('/api/sources', async (req) => {
  deleteAllSources(req.user.id);
  return { ok: true };
});

// ── Manual fetch (admin only) ─────────────────────────────────────────────

fastify.post('/api/fetch', async (req, reply) => {
  if (req.user.role !== 'admin') return reply.code(403).send({ error: 'Forbidden' });
  fetchAllSources().catch(err => fastify.log.error(err));
  return { ok: true };
});

// ── Cron: fetch all sources every 10 minutes ──────────────────────────────

cron.schedule('*/10 * * * *', () => {
  fastify.log.info('Cron: starting scheduled fetch');
  fetchAllSources().catch(err => fastify.log.error(err));
});

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);
await fastify.listen({ host, port });
console.log(`Newsdesk running at http://${host}:${port}`);

import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  User, Source, Article, ArticleWithSource,
  FeedbackRow, InsertArticleParams, InsertSourceParams, UpdateSourceParams,
  AdminSource, AdminArticle,
} from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, '..', 'news.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT CHECK(role IN ('admin', 'user')) DEFAULT 'user',
    approved INTEGER DEFAULT 0,
    blocked INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    name TEXT,
    feed_url TEXT,
    selector TEXT,
    date_selector TEXT,
    image_selector TEXT,
    fetch_type TEXT CHECK(fetch_type IN ('rss', 'html')) NOT NULL DEFAULT 'html',
    max_age_days INTEGER DEFAULT 1,
    color TEXT,
    active INTEGER DEFAULT 1,
    analysis_notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, url)
  );

  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    title TEXT,
    summary TEXT,
    image_url TEXT,
    published_at DATETIME,
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_relevant INTEGER DEFAULT 1,
    relevance_reason TEXT,
    seen INTEGER DEFAULT 0,
    analysis_notes TEXT,
    UNIQUE(source_id, url)
  );

  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER REFERENCES articles(id) ON DELETE CASCADE,
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── Migrations ────────────────────────────────────────────────────────────────

const sourceCols = (db.prepare('PRAGMA table_info(sources)').all() as { name: string }[]).map(c => c.name);
if (!sourceCols.includes('user_id'))       db.exec('ALTER TABLE sources ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
if (!sourceCols.includes('date_selector')) db.exec('ALTER TABLE sources ADD COLUMN date_selector TEXT');
if (!sourceCols.includes('image_selector'))db.exec('ALTER TABLE sources ADD COLUMN image_selector TEXT');
if (!sourceCols.includes('analysis_notes'))db.exec('ALTER TABLE sources ADD COLUMN analysis_notes TEXT');
if (!sourceCols.includes('max_age_days'))  db.exec('ALTER TABLE sources ADD COLUMN max_age_days INTEGER DEFAULT 1');
if (!sourceCols.includes('color'))         db.exec('ALTER TABLE sources ADD COLUMN color TEXT');

// Rebuild sources table if it still has old single-column url unique constraint
const sourceIndexes = db.prepare('PRAGMA index_list(sources)').all() as { unique: number; name: string }[];
const hasOldUrlUnique = sourceIndexes.some(idx => {
  if (!idx.unique) return false;
  const cols = (db.prepare(`PRAGMA index_info(${idx.name})`).all() as { name: string }[]).map(c => c.name);
  return cols.length === 1 && cols[0] === 'url';
});
if (hasOldUrlUnique) {
  db.exec(`
    CREATE TABLE sources_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      name TEXT, feed_url TEXT, selector TEXT, date_selector TEXT, image_selector TEXT,
      fetch_type TEXT CHECK(fetch_type IN ('rss', 'html')) NOT NULL DEFAULT 'html',
      max_age_days INTEGER DEFAULT 1, color TEXT, active INTEGER DEFAULT 1,
      analysis_notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, url)
    );
    INSERT INTO sources_new SELECT id, user_id, url, name, feed_url, selector, date_selector, image_selector, fetch_type, max_age_days, color, active, analysis_notes, created_at FROM sources;
    DROP TABLE sources;
    ALTER TABLE sources_new RENAME TO sources;
  `);
}

const userCols = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map(c => c.name);
if (!userCols.includes('blocked')) db.exec('ALTER TABLE users ADD COLUMN blocked INTEGER DEFAULT 0');

const articleCols = (db.prepare('PRAGMA table_info(articles)').all() as { name: string }[]).map(c => c.name);
if (!articleCols.includes('analysis_notes')) db.exec('ALTER TABLE articles ADD COLUMN analysis_notes TEXT');
if (!articleCols.includes('image_url'))      db.exec('ALTER TABLE articles ADD COLUMN image_url TEXT');
if (!articleCols.includes('relevance_reason')) db.exec('ALTER TABLE articles ADD COLUMN relevance_reason TEXT');

// Rebuild articles table if it still has old global url unique constraint
const articleIndexes = db.prepare('PRAGMA index_list(articles)').all() as { unique: number; name: string }[];
const hasOldArticleUrlUnique = articleIndexes.some(idx => {
  if (!idx.unique) return false;
  const cols = (db.prepare(`PRAGMA index_info(${idx.name})`).all() as { name: string }[]).map(c => c.name);
  return cols.length === 1 && cols[0] === 'url';
});
if (hasOldArticleUrlUnique) {
  db.exec(`
    CREATE TABLE articles_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      title TEXT, summary TEXT, image_url TEXT,
      published_at DATETIME,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_relevant INTEGER DEFAULT 1,
      relevance_reason TEXT,
      seen INTEGER DEFAULT 0,
      analysis_notes TEXT,
      UNIQUE(source_id, url)
    );
    INSERT INTO articles_new SELECT id, source_id, url, title, summary, image_url, published_at, fetched_at, is_relevant, relevance_reason, seen, analysis_notes FROM articles;
    DROP TABLE articles;
    ALTER TABLE articles_new RENAME TO articles;
  `);
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sources_user_id           ON sources(user_id);
  CREATE INDEX IF NOT EXISTS idx_articles_source_id        ON articles(source_id);
  CREATE INDEX IF NOT EXISTS idx_articles_source_url       ON articles(source_id, url);
  CREATE INDEX IF NOT EXISTS idx_articles_source_relevance ON articles(source_id, is_relevant, seen);
  CREATE INDEX IF NOT EXISTS idx_feedback_article_id       ON feedback(article_id);
`);

// ── Users ─────────────────────────────────────────────────────────────────────

export function getUserCount(): number {
  return (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
}

export function getUserByUsername(username: string): User | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;
}

export function getUserById(id: number): User | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}

export function createUser(params: { username: string; password_hash: string; role: string; approved: boolean }) {
  return db.prepare(
    'INSERT INTO users (username, password_hash, role, approved) VALUES (?, ?, ?, ?)'
  ).run(params.username, params.password_hash, params.role, params.approved ? 1 : 0);
}

export function getUsers(): Omit<User, 'password_hash'>[] {
  return db.prepare('SELECT id, username, role, approved, blocked, created_at FROM users ORDER BY created_at').all() as Omit<User, 'password_hash'>[];
}

export function updateUser(id: number, params: { role: string; approved: number; blocked: number }) {
  return db.prepare('UPDATE users SET role = ?, approved = ?, blocked = ? WHERE id = ?')
    .run(params.role, params.approved ? 1 : 0, params.blocked ? 1 : 0, id);
}

export function claimOrphanedSources(userId: number) {
  db.prepare('UPDATE sources SET user_id = ? WHERE user_id IS NULL').run(userId);
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export function createSession(token: string, userId: number) {
  const expires = Date.now() + 30 * 24 * 60 * 60 * 1000;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
}

export function getUserByToken(token: string): User | null {
  const row = db.prepare(`
    SELECT u.* FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, Date.now()) as User | undefined;
  return row ?? null;
}

export function deleteSession(token: string) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// ── Settings ──────────────────────────────────────────────────────────────────

export function getSetting(key: string, fallback: string | null = null): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : fallback;
}

export function setSetting(key: string, value: string) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// ── Sources ───────────────────────────────────────────────────────────────────

export function getSources(userId: number): Source[] {
  return db.prepare('SELECT * FROM sources WHERE user_id = ? ORDER BY created_at DESC').all(userId) as Source[];
}

export function getActiveSources(): Source[] {
  return db.prepare('SELECT * FROM sources WHERE active = 1').all() as Source[];
}

export function getSourceById(id: number): Source | undefined {
  return db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as Source | undefined;
}

export function insertSource(source: InsertSourceParams) {
  return db.prepare(`
    INSERT INTO sources (user_id, url, name, feed_url, selector, date_selector, image_selector, fetch_type, max_age_days, color, analysis_notes)
    VALUES (@user_id, @url, @name, @feed_url, @selector, @date_selector, @image_selector, @fetch_type, @max_age_days, @color, @analysis_notes)
  `).run(source);
}

export function updateSourceActive(id: number, userId: number, active: boolean) {
  return db.prepare('UPDATE sources SET active = ? WHERE id = ? AND user_id = ?').run(active ? 1 : 0, id, userId);
}

export function updateSource(id: number, userId: number, fields: UpdateSourceParams) {
  return db.prepare(`
    UPDATE sources SET name = @name, feed_url = @feed_url, selector = @selector,
      date_selector = @date_selector, image_selector = @image_selector, fetch_type = @fetch_type,
      max_age_days = @max_age_days, color = @color
    WHERE id = @id AND user_id = @userId
  `).run({ ...fields, id, userId });
}

export function deleteSource(id: number, userId: number) {
  return db.prepare('DELETE FROM sources WHERE id = ? AND user_id = ?').run(id, userId);
}

export function deleteAllSources(userId: number) {
  return db.prepare('DELETE FROM sources WHERE user_id = ?').run(userId);
}

// ── Articles ──────────────────────────────────────────────────────────────────

export function getArticles(params: {
  userId: number;
  limit?: number;
  offset?: number;
  read?: string;
  relevance?: string;
}): ArticleWithSource[] {
  const { userId, limit = 50, offset = 0, read = 'all', relevance = 'all' } = params;
  const conditions = ['s.user_id = ?'];
  if (read === 'read')            conditions.push('a.seen = 1');
  if (read === 'unread')          conditions.push('a.seen = 0');
  if (relevance === 'relevant')   conditions.push('a.is_relevant = 1');
  if (relevance === 'irrelevant') conditions.push('a.is_relevant = 0');
  const where = 'WHERE ' + conditions.join(' AND ');
  return db.prepare(`
    SELECT a.*, s.name as source_name, s.url as source_url, s.color as source_color,
      (SELECT reason FROM feedback WHERE article_id = a.id ORDER BY created_at DESC LIMIT 1) as feedback_reason,
      EXISTS(SELECT 1 FROM feedback WHERE article_id = a.id) as user_dismissed
    FROM articles a
    JOIN sources s ON a.source_id = s.id
    ${where}
    ORDER BY COALESCE(a.published_at, a.fetched_at) DESC
    LIMIT ? OFFSET ?
  `).all(userId, limit, offset) as ArticleWithSource[];
}

export function getUnseenCount(userId: number): { count: number } {
  return db.prepare(`
    SELECT COUNT(*) as count FROM articles a
    JOIN sources s ON a.source_id = s.id
    WHERE s.user_id = ? AND a.is_relevant = 1 AND a.seen = 0
  `).get(userId) as { count: number };
}

export function articleExistsByUrl(sourceId: number, url: string): boolean {
  return !!db.prepare('SELECT id FROM articles WHERE source_id = ? AND url = ?').get(sourceId, url);
}

export function insertArticle(article: InsertArticleParams) {
  return db.prepare(`
    INSERT INTO articles (source_id, url, title, summary, image_url, published_at, is_relevant, relevance_reason, analysis_notes)
    VALUES (@source_id, @url, @title, @summary, @image_url, @published_at, @is_relevant, @relevance_reason, @analysis_notes)
  `).run(article);
}

export function markArticleSeen(id: number, userId: number) {
  return db.prepare(`
    UPDATE articles SET seen = 1 WHERE id = ?
    AND source_id IN (SELECT id FROM sources WHERE user_id = ?)
  `).run(id, userId);
}

export function markArticleUnseen(id: number, userId: number) {
  return db.prepare(`
    UPDATE articles SET seen = 0 WHERE id = ?
    AND source_id IN (SELECT id FROM sources WHERE user_id = ?)
  `).run(id, userId);
}

export function markAllSeen(userId: number) {
  return db.prepare(`
    UPDATE articles SET seen = 1
    WHERE is_relevant = 1 AND source_id IN (SELECT id FROM sources WHERE user_id = ?)
  `).run(userId);
}

export function dismissArticle(id: number, userId: number) {
  return db.prepare(`
    UPDATE articles SET is_relevant = 0 WHERE id = ?
    AND source_id IN (SELECT id FROM sources WHERE user_id = ?)
  `).run(id, userId);
}

export function restoreArticle(id: number, userId: number) {
  db.prepare(`
    UPDATE articles SET is_relevant = 1 WHERE id = ?
    AND source_id IN (SELECT id FROM sources WHERE user_id = ?)
  `).run(id, userId);
  db.prepare('DELETE FROM feedback WHERE article_id = ?').run(id);
}

export function deleteAllArticles(userId: number) {
  return db.prepare(`
    DELETE FROM articles WHERE source_id IN (SELECT id FROM sources WHERE user_id = ?)
  `).run(userId);
}

// ── Feedback ──────────────────────────────────────────────────────────────────

export function insertFeedback(articleId: number, reason?: string | null) {
  return db.prepare('INSERT INTO feedback (article_id, reason) VALUES (?, ?)').run(articleId, reason ?? null);
}

export function getRecentFeedback(userId: number, limit = 20): FeedbackRow[] {
  return db.prepare(`
    SELECT a.title, a.summary, f.reason
    FROM feedback f
    JOIN articles a ON f.article_id = a.id
    JOIN sources s ON a.source_id = s.id
    WHERE s.user_id = ?
    ORDER BY f.created_at DESC
    LIMIT ?
  `).all(userId, limit) as FeedbackRow[];
}

// ── Admin resource views ───────────────────────────────────────────────────────

export function getAllSourcesAdmin(): AdminSource[] {
  return db.prepare(`
    SELECT s.id, s.url, s.name, s.fetch_type, s.active, s.created_at, u.username
    FROM sources s
    LEFT JOIN users u ON s.user_id = u.id
    ORDER BY s.created_at DESC
  `).all() as AdminSource[];
}

export function getAllArticlesAdmin(limit = 100): AdminArticle[] {
  return db.prepare(`
    SELECT a.id, a.url, a.title, a.fetched_at, a.is_relevant, a.seen,
           s.name AS source_name, u.username
    FROM articles a
    JOIN sources s ON a.source_id = s.id
    LEFT JOIN users u ON s.user_id = u.id
    ORDER BY a.fetched_at DESC
    LIMIT ?
  `).all(limit) as AdminArticle[];
}

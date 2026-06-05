import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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
    max_age_days INTEGER DEFAULT 7,
    color TEXT,
    active INTEGER DEFAULT 1,
    analysis_notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, url)
  );

  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE,
    url TEXT NOT NULL UNIQUE,
    title TEXT,
    summary TEXT,
    image_url TEXT,
    published_at DATETIME,
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_relevant INTEGER DEFAULT 1,
    relevance_reason TEXT,
    seen INTEGER DEFAULT 0,
    analysis_notes TEXT
  );

  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER REFERENCES articles(id) ON DELETE CASCADE,
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migrate existing sources table columns if needed
const sourceCols = db.prepare("PRAGMA table_info(sources)").all().map(c => c.name);
if (!sourceCols.includes('user_id'))       db.exec('ALTER TABLE sources ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
if (!sourceCols.includes('date_selector')) db.exec('ALTER TABLE sources ADD COLUMN date_selector TEXT');
if (!sourceCols.includes('image_selector'))db.exec('ALTER TABLE sources ADD COLUMN image_selector TEXT');
if (!sourceCols.includes('analysis_notes'))db.exec('ALTER TABLE sources ADD COLUMN analysis_notes TEXT');
if (!sourceCols.includes('max_age_days'))  db.exec('ALTER TABLE sources ADD COLUMN max_age_days INTEGER DEFAULT 7');
if (!sourceCols.includes('color'))         db.exec('ALTER TABLE sources ADD COLUMN color TEXT');

const articleCols = db.prepare("PRAGMA table_info(articles)").all().map(c => c.name);
if (!articleCols.includes('analysis_notes'))db.exec('ALTER TABLE articles ADD COLUMN analysis_notes TEXT');
if (!articleCols.includes('image_url'))    db.exec('ALTER TABLE articles ADD COLUMN image_url TEXT');

// ── Users ─────────────────────────────────────────────────────────────────

export function getUserCount() {
  return db.prepare('SELECT COUNT(*) as count FROM users').get().count;
}

export function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function createUser({ username, password_hash, role, approved }) {
  return db.prepare(
    'INSERT INTO users (username, password_hash, role, approved) VALUES (?, ?, ?, ?)'
  ).run(username, password_hash, role, approved ? 1 : 0);
}

export function getUsers() {
  return db.prepare('SELECT id, username, role, approved, created_at FROM users ORDER BY created_at').all();
}

export function updateUser(id, { role, approved }) {
  return db.prepare('UPDATE users SET role = ?, approved = ? WHERE id = ?').run(role, approved ? 1 : 0, id);
}

// Assign orphaned sources (from before auth) to the first admin
export function claimOrphanedSources(userId) {
  db.prepare('UPDATE sources SET user_id = ? WHERE user_id IS NULL').run(userId);
}

// ── Sessions ──────────────────────────────────────────────────────────────

export function createSession(token, userId) {
  const expires = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
}

export function getUserByToken(token) {
  const row = db.prepare(`
    SELECT u.* FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, Date.now());
  return row ?? null;
}

export function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// ── Settings ──────────────────────────────────────────────────────────────

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// ── Sources ───────────────────────────────────────────────────────────────

export function getSources(userId) {
  return db.prepare('SELECT * FROM sources WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

export function getActiveSources() {
  return db.prepare('SELECT * FROM sources WHERE active = 1').all();
}

export function getSourceById(id) {
  return db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
}

export function insertSource(source) {
  return db.prepare(`
    INSERT INTO sources (user_id, url, name, feed_url, selector, date_selector, image_selector, fetch_type, max_age_days, color, analysis_notes)
    VALUES (@user_id, @url, @name, @feed_url, @selector, @date_selector, @image_selector, @fetch_type, @max_age_days, @color, @analysis_notes)
  `).run(source);
}

export function updateSourceActive(id, active) {
  return db.prepare('UPDATE sources SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
}

export function updateSource(id, fields) {
  return db.prepare(`
    UPDATE sources SET name = @name, feed_url = @feed_url, selector = @selector,
      date_selector = @date_selector, image_selector = @image_selector, fetch_type = @fetch_type,
      max_age_days = @max_age_days, color = @color
    WHERE id = @id
  `).run({ ...fields, id });
}

export function deleteSource(id, userId) {
  return db.prepare('DELETE FROM sources WHERE id = ? AND user_id = ?').run(id, userId);
}

export function deleteAllSources(userId) {
  return db.prepare('DELETE FROM sources WHERE user_id = ?').run(userId);
}

// ── Articles ──────────────────────────────────────────────────────────────

export function getArticles({ userId, limit = 50, offset = 0, read = 'all', relevance = 'all' } = {}) {
  const conditions = ['s.user_id = ?'];
  if (read === 'read')           conditions.push('a.seen = 1');
  if (read === 'unread')         conditions.push('a.seen = 0');
  if (relevance === 'relevant')  conditions.push('a.is_relevant = 1');
  if (relevance === 'irrelevant')conditions.push('a.is_relevant = 0');
  const where = 'WHERE ' + conditions.join(' AND ');
  return db.prepare(`
    SELECT a.*, s.name as source_name, s.url as source_url, s.color as source_color,
      (SELECT reason FROM feedback WHERE article_id = a.id ORDER BY created_at DESC LIMIT 1) as feedback_reason
    FROM articles a
    JOIN sources s ON a.source_id = s.id
    ${where}
    ORDER BY COALESCE(a.published_at, a.fetched_at) DESC
    LIMIT ? OFFSET ?
  `).all(userId, limit, offset);
}

export function getUnseenCount(userId) {
  return db.prepare(`
    SELECT COUNT(*) as count FROM articles a
    JOIN sources s ON a.source_id = s.id
    WHERE s.user_id = ? AND a.is_relevant = 1 AND a.seen = 0
  `).get(userId);
}

export function articleExistsByUrl(url) {
  return db.prepare('SELECT id FROM articles WHERE url = ?').get(url);
}

export function insertArticle(article) {
  return db.prepare(`
    INSERT INTO articles (source_id, url, title, summary, image_url, published_at, is_relevant, relevance_reason, analysis_notes)
    VALUES (@source_id, @url, @title, @summary, @image_url, @published_at, @is_relevant, @relevance_reason, @analysis_notes)
  `).run(article);
}

export function markArticleSeen(id) {
  return db.prepare('UPDATE articles SET seen = 1 WHERE id = ?').run(id);
}

export function markArticleUnseen(id) {
  return db.prepare('UPDATE articles SET seen = 0 WHERE id = ?').run(id);
}

export function markAllSeen(userId) {
  return db.prepare(`
    UPDATE articles SET seen = 1
    WHERE is_relevant = 1 AND source_id IN (SELECT id FROM sources WHERE user_id = ?)
  `).run(userId);
}

export function dismissArticle(id) {
  return db.prepare('UPDATE articles SET is_relevant = 0 WHERE id = ?').run(id);
}

export function restoreArticle(id) {
  db.prepare('UPDATE articles SET is_relevant = 1 WHERE id = ?').run(id);
  db.prepare('DELETE FROM feedback WHERE article_id = ?').run(id);
}

export function deleteAllArticles(userId) {
  return db.prepare(`
    DELETE FROM articles WHERE source_id IN (SELECT id FROM sources WHERE user_id = ?)
  `).run(userId);
}

// ── Feedback ──────────────────────────────────────────────────────────────

export function insertFeedback(articleId, reason) {
  return db.prepare('INSERT INTO feedback (article_id, reason) VALUES (?, ?)').run(articleId, reason ?? null);
}

export function getRecentFeedback(userId, limit = 20) {
  return db.prepare(`
    SELECT a.title, a.summary, f.reason
    FROM feedback f
    JOIN articles a ON f.article_id = a.id
    JOIN sources s ON a.source_id = s.id
    WHERE s.user_id = ?
    ORDER BY f.created_at DESC
    LIMIT ?
  `).all(userId, limit);
}

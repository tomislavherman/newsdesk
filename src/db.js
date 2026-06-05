import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, '..', 'news.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    name TEXT,
    feed_url TEXT,
    selector TEXT,
    date_selector TEXT,
    image_selector TEXT,
    fetch_type TEXT CHECK(fetch_type IN ('rss', 'html')) NOT NULL DEFAULT 'html',
    max_age_days INTEGER DEFAULT 7,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
    seen INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER REFERENCES articles(id) ON DELETE CASCADE,
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migrate existing tables
const sourceCols = db.prepare("PRAGMA table_info(sources)").all().map(c => c.name);
if (!sourceCols.includes('date_selector'))  db.exec('ALTER TABLE sources ADD COLUMN date_selector TEXT');
if (!sourceCols.includes('image_selector')) db.exec('ALTER TABLE sources ADD COLUMN image_selector TEXT');
if (!sourceCols.includes('analysis_notes')) db.exec('ALTER TABLE sources ADD COLUMN analysis_notes TEXT');
if (!sourceCols.includes('max_age_days'))   db.exec('ALTER TABLE sources ADD COLUMN max_age_days INTEGER DEFAULT 7');
if (!sourceCols.includes('color'))          db.exec('ALTER TABLE sources ADD COLUMN color TEXT');

const articleCols = db.prepare("PRAGMA table_info(articles)").all().map(c => c.name);
if (!articleCols.includes('analysis_notes')) db.exec('ALTER TABLE articles ADD COLUMN analysis_notes TEXT');
if (!articleCols.includes('image_url'))      db.exec('ALTER TABLE articles ADD COLUMN image_url TEXT');

// Sources
export function getSources() {
  return db.prepare('SELECT * FROM sources ORDER BY created_at DESC').all();
}

export function getActiveSources() {
  return db.prepare('SELECT * FROM sources WHERE active = 1').all();
}

export function insertSource(source) {
  return db.prepare(`
    INSERT INTO sources (url, name, feed_url, selector, date_selector, image_selector, fetch_type, max_age_days, color, analysis_notes)
    VALUES (@url, @name, @feed_url, @selector, @date_selector, @image_selector, @fetch_type, @max_age_days, @color, @analysis_notes)
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

export function getSourceById(id) {
  return db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
}

export function deleteSource(id) {
  return db.prepare('DELETE FROM sources WHERE id = ?').run(id);
}

export function deleteAllSources() {
  return db.prepare('DELETE FROM sources').run();
}

// Articles
// read: 'all' | 'read' | 'unread'
// relevance: 'all' | 'relevant' | 'irrelevant'
export function getArticles({ limit = 50, offset = 0, read = 'all', relevance = 'all' } = {}) {
  const conditions = [];
  if (read === 'read') conditions.push('a.seen = 1');
  if (read === 'unread') conditions.push('a.seen = 0');
  if (relevance === 'relevant') conditions.push('a.is_relevant = 1');
  if (relevance === 'irrelevant') conditions.push('a.is_relevant = 0');
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  return db.prepare(`
    SELECT a.*, s.name as source_name, s.url as source_url, s.color as source_color,
      (SELECT reason FROM feedback WHERE article_id = a.id ORDER BY created_at DESC LIMIT 1) as feedback_reason
    FROM articles a
    LEFT JOIN sources s ON a.source_id = s.id
    ${where}
    ORDER BY COALESCE(a.published_at, a.fetched_at) DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}

export function getUnseenCount() {
  return db.prepare('SELECT COUNT(*) as count FROM articles WHERE is_relevant = 1 AND seen = 0').get();
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

export function markAllSeen() {
  return db.prepare('UPDATE articles SET seen = 1 WHERE is_relevant = 1').run();
}

export function dismissArticle(id) {
  return db.prepare('UPDATE articles SET is_relevant = 0 WHERE id = ?').run(id);
}

export function restoreArticle(id) {
  db.prepare('UPDATE articles SET is_relevant = 1 WHERE id = ?').run(id);
  db.prepare('DELETE FROM feedback WHERE article_id = ?').run(id);
}

export function deleteAllArticles() {
  return db.prepare('DELETE FROM articles').run();
}

// Feedback
export function insertFeedback(articleId, reason) {
  return db.prepare('INSERT INTO feedback (article_id, reason) VALUES (?, ?)').run(articleId, reason ?? null);
}

export function getRecentFeedback(limit = 20) {
  return db.prepare(`
    SELECT a.title, a.summary, f.reason
    FROM feedback f
    JOIN articles a ON f.article_id = a.id
    ORDER BY f.created_at DESC
    LIMIT ?
  `).all(limit);
}

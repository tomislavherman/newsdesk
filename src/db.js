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
    fetch_type TEXT CHECK(fetch_type IN ('rss', 'html')) NOT NULL DEFAULT 'html',
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE,
    url TEXT NOT NULL UNIQUE,
    title TEXT,
    summary TEXT,
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

// Sources
export function getSources() {
  return db.prepare('SELECT * FROM sources ORDER BY created_at DESC').all();
}

export function getActiveSources() {
  return db.prepare('SELECT * FROM sources WHERE active = 1').all();
}

export function insertSource(source) {
  const stmt = db.prepare(`
    INSERT INTO sources (url, name, feed_url, selector, fetch_type)
    VALUES (@url, @name, @feed_url, @selector, @fetch_type)
  `);
  return stmt.run(source);
}

export function updateSourceActive(id, active) {
  return db.prepare('UPDATE sources SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
}

export function deleteSource(id) {
  return db.prepare('DELETE FROM sources WHERE id = ?').run(id);
}

// Articles
export function getArticles({ limit = 50, offset = 0, unseen = false } = {}) {
  const where = unseen ? 'WHERE is_relevant = 1 AND seen = 0' : 'WHERE is_relevant = 1';
  return db.prepare(`
    SELECT a.*, s.name as source_name, s.url as source_url
    FROM articles a
    LEFT JOIN sources s ON a.source_id = s.id
    ${where}
    ORDER BY a.fetched_at DESC
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
  const stmt = db.prepare(`
    INSERT INTO articles (source_id, url, title, summary, published_at, is_relevant, relevance_reason)
    VALUES (@source_id, @url, @title, @summary, @published_at, @is_relevant, @relevance_reason)
  `);
  return stmt.run(article);
}

export function markArticleSeen(id) {
  return db.prepare('UPDATE articles SET seen = 1 WHERE id = ?').run(id);
}

export function markAllSeen() {
  return db.prepare('UPDATE articles SET seen = 1 WHERE is_relevant = 1').run();
}

export function dismissArticle(id) {
  return db.prepare('UPDATE articles SET is_relevant = 0 WHERE id = ?').run(id);
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

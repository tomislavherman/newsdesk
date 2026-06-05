# Newsdesk — Project Handoff Document

This document gives Claude Code full context to take over development of the Newsdesk project.

---

## What this project is

A personal news reader with AI-powered relevance filtering. It periodically fetches articles from configured news sources, uses Claude to classify relevance and generate summaries, and serves a minimal web UI where the user can read articles and provide feedback. Feedback is used to improve future classification.

**This is a personal side project** — one user, one server, no scale requirements. Decisions should favor simplicity over sophistication.

---

## Tech stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node.js 20 (ES modules) | Developer preference |
| Web framework | Fastify v5 | Modern, fast, minimal |
| Database | SQLite via better-sqlite3 | Zero ops, single user, more than sufficient |
| AI | Anthropic Claude Haiku (`claude-haiku-4-5-20251001`) | Cheap, fast, sufficient for classification |
| Scheduling | node-cron (inside same process) | Avoids second systemd unit |
| HTML parsing | cheerio | CSS selector based scraping |
| RSS parsing | rss-parser | Standard RSS/Atom handling |
| HTTP client | undici (fetch) | Built into Node ecosystem |
| Process manager | systemd | Standard Linux, learning goal for developer |
| Access | Tailscale Serve | Developer accesses only from own devices via Tailnet |

---

## Project structure

```
news-app/
├── src/
│   ├── index.js        # Fastify server, all API routes, cron scheduler
│   ├── db.js           # SQLite schema + all database access functions
│   ├── ai.js           # Claude integration (source analysis + classification)
│   └── fetcher.js      # RSS + HTML article fetching logic
├── public/
│   └── index.html      # Single-page frontend (vanilla JS, no framework)
├── newsdesk.service    # systemd unit file for Oracle VM deployment
├── .env.example        # Environment variable template
├── package.json
└── README.md           # Setup and deployment instructions
```

---

## Database schema

Three tables in SQLite (`news.db` in project root):

```sql
-- News sources added by user at runtime
CREATE TABLE sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,       -- homepage URL
  name TEXT,                      -- human readable name
  feed_url TEXT,                  -- RSS feed URL if detected, else null
  selector TEXT,                  -- CSS selector for HTML scraping if no RSS
  fetch_type TEXT CHECK(fetch_type IN ('rss', 'html')) NOT NULL DEFAULT 'html',
  active INTEGER DEFAULT 1,       -- can be paused without deleting
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Articles fetched from sources
CREATE TABLE articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE,
  url TEXT NOT NULL UNIQUE,       -- deduplicated by URL
  title TEXT,
  summary TEXT,                   -- Claude-generated 2-3 sentence neutral summary
  published_at DATETIME,
  fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_relevant INTEGER DEFAULT 1,  -- 0 = filtered out by Claude or dismissed by user
  relevance_reason TEXT,          -- Claude's one-sentence explanation
  seen INTEGER DEFAULT 0          -- user has viewed/clicked
);

-- User "Not interested" dismissals
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER REFERENCES articles(id) ON DELETE CASCADE,
  reason TEXT,                    -- optional free text from user
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## API routes

All routes are in `src/index.js`.

### Articles
| Method | Path | Description |
|---|---|---|
| GET | `/api/articles` | List articles. Query params: `limit`, `offset`, `unseen=true` |
| POST | `/api/articles/:id/seen` | Mark single article as seen |
| POST | `/api/articles/seen-all` | Mark all relevant articles as seen |
| POST | `/api/articles/:id/feedback` | Dismiss article. Body: `{ reason?: string }` |

### Sources
| Method | Path | Description |
|---|---|---|
| GET | `/api/sources` | List all sources |
| POST | `/api/sources/analyze` | Analyze a URL (calls Claude). Body: `{ url }`. Returns detected config |
| POST | `/api/sources` | Add a source using analyzed config |
| PATCH | `/api/sources/:id` | Toggle active. Body: `{ active: boolean }` |
| DELETE | `/api/sources/:id` | Delete source and its articles |

### Utility
| Method | Path | Description |
|---|---|---|
| POST | `/api/fetch` | Trigger a fetch cycle manually (runs in background) |

---

## AI integration (src/ai.js)

Two Claude calls, both using Haiku and expecting JSON responses:

### 1. `analyzeSource(url, html)`
Called once when a user adds a new source. Sends the first 15,000 chars of the page HTML to Claude and asks it to:
- Detect RSS feed URL (from `<link rel="alternate">` tags)
- If no RSS: identify a CSS selector for article containers
- Suggest a human-readable source name

Returns: `{ has_rss, feed_url, selector, name }`

### 2. `classifyArticle(title, content)`
Called for every new article during a fetch cycle. Includes the last 20 user feedback dismissals as context so Claude learns preferences over time.

Returns: `{ is_relevant, reason, summary }`

Both functions parse JSON from Claude's response with a fallback regex extraction in case Claude adds surrounding text.

---

## Fetch cycle logic (src/fetcher.js)

`fetchAllSources()` is the main entry point, called by cron and the manual fetch endpoint:

1. Gets all active sources from DB
2. For each source:
   - If `fetch_type = 'rss'`: uses `rss-parser` to fetch the feed URL
   - If `fetch_type = 'html'`: fetches the source URL, loads with cheerio, applies CSS selector
3. For each article found, checks if URL already exists in DB (deduplication)
4. For new articles: calls `classifyArticle()`, stores result
5. Logs counts at each step

`detectSourceConfig(url)` is the source setup helper — fetches the page and calls `analyzeSource()`.

---

## Frontend (public/index.html)

Single HTML file, vanilla JS, no build step, no framework.

**Design**: Editorial aesthetic. Playfair Display (serif) for headings, DM Sans for body. Warm off-white background (`#f5f2ed`). Red accent (`#c0392b`) for source tags and unread badge. Clean card layout.

**Two views** (tab-switched, no routing):
- **Articles** — card list with title, source tag, date, summary, "Read full article" link, "Not interested" button with inline feedback form
- **Sources** — list of configured sources with pause/resume and delete, plus "Add source" button

**Add source flow**:
1. User pastes URL
2. Clicks "Analyze URL" → calls `/api/sources/analyze` → shows detected config preview
3. User clicks "Add source" → calls `/api/sources`

**Unread badge**: shown in header, updates on load and every 5 minutes via polling.

---

## Deployment target

**Server**: Oracle Cloud free tier VM — `VM.Standard.E2.1.Micro` (AMD, 1/8 OCPU shared, 1GB RAM, x86).
The developer is also trying to provision a `VM.Standard.A1.Flex` (ARM, 4 OCPU, 24GB RAM) but it's currently showing "Out of capacity". Code should work on both architectures.

**OS**: Ubuntu 24 (assumed, standard Oracle Cloud image)

**Access**: Tailscale Serve on port 3000. The app binds to `127.0.0.1` by default — Tailscale Serve proxies to it. No public ports needed beyond SSH (22).

**Process management**: systemd. `newsdesk.service` is the unit file. `EnvironmentFile` points to `.env` in the project directory for secrets.

**Deployment method**: Currently rsync + SSH or git pull, manual. No CI/CD yet.

---

## Environment variables

```
ANTHROPIC_API_KEY=   # Required. Get from platform.claude.com
PORT=3000            # Optional, defaults to 3000
HOST=127.0.0.1       # Optional, defaults to 127.0.0.1 (Tailscale Serve handles external access)
```

`.env` file is excluded from deployment syncs. Managed manually on server. Never committed to git.

---

## Key decisions and their rationale

**SQLite over Oracle Autonomous DB or MySQL**: zero ops, no network config, no auth setup. Appropriate for single-user scale. The free Oracle DB options (Autonomous DB requires wallet files + native C++ driver; MySQL requires separate service setup) add friction with no benefit at this scale.

**Haiku over Sonnet/Opus**: classification and summarization are not hard reasoning tasks. Haiku handles them well at ~10x lower cost. Estimated monthly cost with batch processing: $3-7.

**node-cron inside web process over systemd timer**: one systemd unit is simpler to manage than two. The cron job is lightweight (HTTP calls out, DB writes) and doesn't interfere with request handling.

**No frontend framework**: the UI is simple enough that React/Vue would add build tooling complexity with no benefit. Vanilla JS is sufficient and keeps deployment trivial (static file, no build step).

**Feedback as prompt context over vector embeddings**: simpler, transparent, and sufficient. Claude receives the last 20 dismissals as plain text and pattern-matches from examples. A vector database would add significant infrastructure complexity for marginal improvement at this scale (100 articles/day).

**Two-step source add (analyze then confirm)**: gives the user visibility into what Claude detected before committing. Avoids silent failures where a wrong CSS selector is stored and silently fetches nothing.

---

## Known limitations and future improvements

These are known gaps, not bugs. Tackle in priority order as needed:

1. **No error recovery for bad selectors**: if Claude picks a wrong CSS selector for a source, articles silently fail to fetch. Should add a "last fetch result" field to sources and surface errors in the UI.

2. **Article content for classification is shallow**: the fetcher only uses text from the selector container, which may be just a headline + teaser. Better classification would fetch the full article page for content. Trade-off: more API calls to news sites, slower fetch cycle.

3. **No pagination in UI**: loads up to 100 articles. Fine for now, will need pagination eventually.

4. **Summary length and style are hardcoded**: currently 2-3 sentences, neutral factual. Developer wants these as user-configurable settings. A `settings` table in SQLite and a settings page in the UI would cover this.

5. **No dark mode**: CSS variables are in place, adding a dark theme is a small CSS addition.

6. **Fetch runs serially**: sources are processed one by one. For 10 sources this is fine. Could be parallelized with `Promise.allSettled()` if fetch cycle becomes slow.

7. **No notification beyond badge**: developer checks the site periodically. Could add optional push notifications or email digest later.

---

## How to get started as Claude Code

1. Read this document fully first
2. Run `npm install` to install dependencies
3. Copy `.env.example` to `.env` and add a real `ANTHROPIC_API_KEY`
4. Run `npm run dev` and verify the server starts
5. Open `http://localhost:3000` and verify the UI loads
6. Add a test source (e.g. a news site with RSS) and click "Fetch now"
7. Check `journalctl` equivalent (`console` output in dev) for fetch logs

Ask the developer what they want to work on next before making changes.

# Newsdesk

A personal news reader with AI-powered relevance filtering. It periodically fetches articles from configured news sources, uses Claude to classify relevance and generate summaries, and serves a minimal web UI where users can read articles and provide feedback.

**This is a personal side project** — decisions should favor simplicity over sophistication.

---

## Tech stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node.js 20 (ES modules) | Developer preference |
| Web framework | Fastify v5 | Modern, fast, minimal |
| Database | SQLite via better-sqlite3 | Zero ops, no scale requirements |
| AI | Anthropic Claude Haiku (`claude-haiku-4-5-20251001`) | Cheap, fast, sufficient for classification |
| Scheduling | node-cron (inside same process) | Avoids second systemd unit |
| HTML parsing | cheerio | CSS selector based scraping |
| RSS parsing | rss-parser | Standard RSS/Atom handling |
| HTTP client | undici (fetch) | Built into Node ecosystem |
| Process manager | systemd | Standard Linux |
| Access | Tailscale Serve | Developer accesses only from own devices via Tailnet |

---

## Project structure

```
newsdesk/
├── src/
│   ├── index.js        # Fastify server, all API routes, cron scheduler
│   ├── db.js           # SQLite schema + all database access functions
│   ├── auth.js         # Password hashing (crypto.scrypt) + session token generation
│   ├── ai.js           # Claude integration (source analysis + classification)
│   └── fetcher.js      # RSS + HTML article fetching logic
├── public/
│   └── index.html      # Single-page frontend (vanilla JS, no framework)
├── newsdesk.service    # systemd unit file for Oracle VM deployment
├── .env.example        # Environment variable template
├── package.json
└── README.md
```

---

## Authentication system

Users authenticate with username + password. Sessions are stored in SQLite and sent as `HttpOnly` cookies (30-day expiry). Passwords hashed with `crypto.scrypt` — no bcrypt dependency.

**User roles:**
- First user to sign up becomes `admin` (approved automatically)
- Subsequent users get role `user`, status `approved = 0` (pending)
- Admin can approve users, toggle roles between `user` and `admin`
- Admin cannot change their own role
- Unapproved users see a "pending approval" screen, not the app

**Auto-approve setting**: admin can toggle `auto_approve` in the settings panel — when on, new signups are immediately approved.

**Admin capabilities** (gated by `role === 'admin'` in both backend and frontend):
- Wipe articles / Wipe sources buttons
- Manual "Fetch now" button
- Admin panel tab (user management + auto-approve toggle)

**Public API paths** (no auth required): `/api/auth/login`, `/api/auth/signup`, `/api/auth/me`

**Admin API paths**: `/api/admin/*` — returns 403 if not admin

---

## Database schema

Six tables in SQLite (`news.db` in project root):

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,         -- scrypt: "salt:hash"
  role TEXT NOT NULL DEFAULT 'user',   -- 'user' | 'admin'
  approved INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,              -- 64-byte hex random
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  expires_at DATETIME NOT NULL         -- 30 days from creation
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- News sources — scoped to users
CREATE TABLE sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  name TEXT,
  feed_url TEXT,
  selector TEXT,
  fetch_type TEXT CHECK(fetch_type IN ('rss', 'html')) NOT NULL DEFAULT 'html',
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, url)
);

CREATE TABLE articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE,
  url TEXT NOT NULL UNIQUE,
  title TEXT,
  summary TEXT,                        -- Claude-generated 2-3 sentence neutral summary
  published_at DATETIME,
  fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_relevant INTEGER DEFAULT 1,
  relevance_reason TEXT,
  seen INTEGER DEFAULT 0
);

CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER REFERENCES articles(id) ON DELETE CASCADE,
  reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**Per-user isolation**: sources carry `user_id`; articles are scoped via JOIN through their source. Feedback learning (`getRecentFeedback`) is also user-scoped.

**Cron exception**: `getActiveSources()` (used by the cron job) returns all users' sources — fetch runs across all users.

**Orphaned sources**: pre-auth sources with `user_id = NULL` are claimed by the first admin on signup via `claimOrphanedSources(userId)`.

---

## API routes

All routes in `src/index.js`. All `/api/*` routes (except public paths above) require a valid session cookie.

### Auth
| Method | Path | Description |
|---|---|---|
| GET | `/api/auth/me` | Returns `{ user }` or `{ user: null }` |
| POST | `/api/auth/signup` | Body: `{ username, password }`. Returns `{ user }` or `{ pending: true }` |
| POST | `/api/auth/login` | Body: `{ username, password }`. Returns `{ user }` |
| POST | `/api/auth/logout` | Clears session cookie |

### Articles
| Method | Path | Description |
|---|---|---|
| GET | `/api/articles` | List articles (current user only). Params: `limit`, `offset`, `unseen=true` |
| POST | `/api/articles/:id/seen` | Mark single article as seen |
| POST | `/api/articles/seen-all` | Mark all relevant articles as seen |
| POST | `/api/articles/:id/feedback` | Dismiss article. Body: `{ reason?: string }` |

### Sources
| Method | Path | Description |
|---|---|---|
| GET | `/api/sources` | List sources (current user only) |
| POST | `/api/sources/analyze` | Analyze a URL (calls Claude). Body: `{ url }` |
| POST | `/api/sources` | Add a source |
| PATCH | `/api/sources/:id` | Toggle active. Body: `{ active: boolean }` |
| DELETE | `/api/sources/:id` | Delete source and its articles |

### Admin (role=admin only)
| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/users` | List all users (no password_hash) |
| PATCH | `/api/admin/users/:id` | Update `role` and/or `approved`. Cannot change own role. |
| GET | `/api/admin/settings` | Returns `{ auto_approve: boolean }` |
| PATCH | `/api/admin/settings` | Body: `{ auto_approve: boolean }` |

### Utility (admin only)
| Method | Path | Description |
|---|---|---|
| POST | `/api/fetch` | Trigger a fetch cycle manually (runs in background) |

---

## AI integration (src/ai.js)

Two Claude calls, both using Haiku and expecting JSON responses.

### `analyzeSource(url, html)`
Called once when a user adds a new source. Sends the first 15,000 chars of HTML. Only uses explicit `<link rel="alternate">` tags to detect RSS — does NOT guess common paths like `/rss.xml` (caused wrong feeds in practice).

Returns: `{ has_rss, feed_url, selector, name }`

### `classifyArticle(title, content, userId)`
Called for every new article during a fetch cycle. Includes the last 20 feedback dismissals for that user as context. `userId` is passed from `fetcher.js` via `source.user_id`.

Returns: `{ is_relevant, reason, summary }`

Both functions parse JSON with a fallback regex in case Claude adds surrounding text.

---

## Fetch cycle logic (src/fetcher.js)

`fetchAllSources()` is the main entry point, called by cron (every 10 min) and the manual fetch endpoint:

1. Gets all active sources from DB (all users, no filter)
2. For each source:
   - `rss`: uses `rss-parser`. If RSS parse fails, returns `[]` silently (guards against sources stored as wrong type)
   - `html`: fetches the URL, loads with cheerio, applies CSS selector
3. Deduplicates new articles by URL
4. For new articles: calls `classifyArticle(title, content, source.user_id)`, stores result

**HN-specific fixes applied**: title rank numbers stripped (`/^\d+[.)]\s*/`), article link scoring prefers external links and longest text to avoid vote-arrow anchors.

`detectSourceConfig(url)` — fetches page, calls `analyzeSource()`.

---

## Frontend (public/index.html)

Single HTML file, vanilla JS, no build step, no framework.

**Design**: Editorial aesthetic. Playfair Display (serif) for headings, DM Sans for body. Warm off-white background (`#f5f2ed`). Red accent (`#c0392b`) for source tags and unread badge.

**Views** (tab-switched, no routing):
- **Articles** — card list with title, source tag, date, summary, "Read full article", "Not interested"
- **Sources** — configured sources with pause/resume, delete, and "Add source"
- **Admin** — visible only to admins; user table (approve, change role) + auto-approve toggle

**Auth overlay**: shown before app loads. Three states: login form, signup form, pending-approval message. `initAuth()` calls `/api/auth/me` on load to decide which state to show.

**Add source flow**: paste URL → "Analyze URL" → preview detected config → "Add source"

**Unread badge**: shown in header, updates on load and every 5 minutes.

**Admin buttons** (Wipe articles, Fetch now): shown only when `currentUser.role === 'admin'`. No `ADMIN_MODE` env var — that has been removed.

---

## Deployment target

**Server**: Oracle Cloud free tier VM — `VM.Standard.E2.1.Micro` (AMD, 1/8 OCPU shared, 1GB RAM, x86). Also targeting `VM.Standard.A1.Flex` (ARM, 4 OCPU, 24GB RAM) when available.

**OS**: Ubuntu 24

**Access**: Tailscale Serve on port 3000. App binds to `127.0.0.1`.

**Process management**: systemd (`newsdesk.service`). `EnvironmentFile` points to `.env`.

**Deployment**: manual rsync + SSH or git pull.

---

## Environment variables

```
ANTHROPIC_API_KEY=   # Required
POSTHOG_API_KEY=     # Optional. Enables analytics and LLM observability
POSTHOG_HOST=        # Optional. Defaults to https://us.i.posthog.com
PORT=3000            # Optional, defaults to 3000
HOST=127.0.0.1       # Optional, defaults to 127.0.0.1
```

`.env` is gitignored and managed manually on the server. Never committed.

---

## Key decisions and rationale

**`crypto.scrypt` over bcrypt**: avoids adding a dependency; Node built-in is sufficient for this use case.

**Sessions in SQLite over JWTs**: simpler, revocable, consistent with the rest of the stack. 30-day expiry, deleted on logout.

**Per-user source/article isolation via `user_id` FK**: clean cascade deletes, no cross-user leakage. Cron intentionally bypasses user filter to fetch all sources in one cycle.

**SQLite over Oracle Autonomous DB or MySQL**: zero ops, no network config. The free Oracle DB options add friction with no benefit at this scale.

**Haiku over Sonnet/Opus**: classification and summarization are not hard reasoning tasks. Estimated monthly cost: $3–7.

**node-cron inside web process over systemd timer**: one systemd unit is simpler to manage than two.

**No frontend framework**: vanilla JS is sufficient; keeps deployment trivial.

**Feedback as prompt context over vector embeddings**: Claude receives the last 20 dismissals as plain text. Vector DB would add infrastructure complexity for marginal improvement at this scale.

**RSS detection from `<link rel="alternate">` only**: common-path guessing (`/rss.xml`, `/feed`) caused wrong feeds (e.g. sitewide feed instead of topic feed).

---

## Known limitations and future improvements

1. **No error recovery for bad selectors**: articles silently fail. Should add a "last fetch result" field to sources and surface errors in UI.

2. **Article content for classification is shallow**: fetcher uses selector container text (headline + teaser). Better classification would fetch the full article page.

3. **No pagination in UI**: loads up to 100 articles.

4. **Summary length and style are hardcoded**: 2-3 sentences, neutral. Could be user-configurable via the `settings` table.

5. **No dark mode**: CSS variables are in place; adding a dark theme is a small CSS addition.

6. **Fetch runs serially**: fine for ~10 sources. Could parallelize with `Promise.allSettled()` if slow.

7. **No notification beyond badge**: periodic checking only. Could add push notifications or email digest.

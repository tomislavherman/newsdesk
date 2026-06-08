# Newsdesk

A personal news reader with AI-powered relevance filtering. Periodically fetches articles from configured sources, classifies them with Claude, and serves a minimal web UI.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY
npm run dev
```

Open http://localhost:3000

## Deployment (Oracle Cloud + Tailscale)

```bash
# On the server
git clone <repo> ~/newsdesk
cd ~/newsdesk
npm install
cp .env.example .env
nano .env  # add ANTHROPIC_API_KEY

sudo cp newsdesk.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now newsdesk
```

Configure Tailscale Serve to proxy port 3000.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | required | Anthropic API key |
| `POSTHOG_API_KEY` | optional | Enables analytics and LLM observability |
| `POSTHOG_HOST` | `https://us.i.posthog.com` | PostHog ingestion host (use EU endpoint if on EU cloud) |
| `PORT` | `3000` | Server port |
| `HOST` | `127.0.0.1` | Bind address |

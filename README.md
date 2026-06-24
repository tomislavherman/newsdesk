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

## Deployment (public domain)

To expose the app directly on a public IP/domain instead of via Tailscale:

**1. Bind to all interfaces** — in `.env`:
```
HOST=0.0.0.0
```

**2. Allow port 3000 through the OS firewall** (Ubuntu with iptables):
```bash
sudo iptables -I INPUT 6 -p tcp --dport 3000 -j ACCEPT
```

Persist the rule across reboots:
```bash
sudo apt install iptables-persistent -y
sudo netfilter-persistent save
```

**3. Open port 3000 in OCI console** — add an ingress rule for TCP port 3000 in your VCN Security List or Network Security Group.

**4. Restart the service**:
```bash
sudo systemctl restart newsdesk
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | required | Anthropic API key |
| `POSTHOG_API_KEY` | optional | Enables analytics and LLM observability |
| `POSTHOG_HOST` | `https://us.i.posthog.com` | PostHog ingestion host (use EU endpoint if on EU cloud) |
| `PORT` | `3000` | Server port |
| `HOST` | `127.0.0.1` | Bind address |

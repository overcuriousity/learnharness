# Server deployment

One trusted user, one Node process bound to `127.0.0.1`, nginx in front for TLS. Files: [`deploy/learnharness.service`](../deploy/learnharness.service), [`deploy/nginx.conf.example`](../deploy/nginx.conf.example).

## Install

Requires Linux, Node.js 26 (the version CI uses) and nginx; for web search, a SearXNG instance (or a Tavily/Brave API key). Build on the server itself (or the same OS/CPU): the standalone output contains native binaries.

1. Create the service user and folders:
   ```bash
   sudo useradd --system --home-dir /var/lib/learnharness --shell /usr/sbin/nologin learnharness
   sudo install -d -o learnharness -g learnharness -m 0700 /var/lib/learnharness/data /var/lib/learnharness/secrets
   sudo install -d -g learnharness -m 0750 /srv/learnharness/library
   sudo install -d -o learnharness -g learnharness -m 0750 /srv/learnharness/library/uploads
   ```
2. Build:
   ```bash
   git clone https://github.com/overcuriousity/learnharness.git /opt/learnharness/src
   cd /opt/learnharness/src && npm ci --no-audit --no-fund && npm run build
   ```
   `npm run build` runs `next build` and `scripts/build-server.mjs`, which copies `.next/static` and `public/` into `.next/standalone`. The build needs no network beyond `npm ci`.
3. Install the output: `sudo rsync -a --delete .next/standalone/ /opt/learnharness/app/`
4. Install the unit: copy `deploy/learnharness.service` to `/etc/systemd/system/`, set `LH_PUBLIC_ORIGIN` (and `CHROME_PATH` if wanted), then `sudo systemctl daemon-reload && sudo systemctl enable --now learnharness`.
5. Install nginx: adapt `deploy/nginx.conf.example` (host name, certificate paths), then `sudo nginx -t && sudo systemctl reload nginx`.
6. Open the site, add a model key under Settings → Providers, and set `SEARXNG_URL` (or a Tavily/Brave key) under Providers → Search.

**Updating:** `git pull` (or merge an upstream release, below), repeat steps 2–3, `sudo systemctl restart learnharness`.

## Environment

| Variable | Purpose |
|---|---|
| `HOSTNAME=127.0.0.1`, `PORT=3000` | Listen address; only nginx talks to it. |
| `NODE_ENV=production`, `NEXT_TELEMETRY_DISABLED=1` | Production; no Next.js telemetry. |
| `LH_SERVER_MODE=1` | Disables the Claude Code provider (it would run the `claude` CLI as the service user) and ChatGPT sign-in (its callback listens on the server's own `127.0.0.1`). Copilot and Grok (device codes) work. |
| `LH_DATA_DIR` | Chats, graph, settings, jobs. |
| `LH_AUTH_FILE` | API keys (`auth.json`). Subscription credentials are stored in the same folder. |
| `LH_LIBRARY_DIR` | The only folder the agent's file tools can read; uploads land in its `uploads/`. Unset = no file tools. Must not overlap the data or auth folders. |
| `LH_PUBLIC_ORIGIN` | The browser-facing origin, e.g. `https://learn.example.org`. Required behind TLS: same-origin checks would otherwise see `http:` and refuse (403). |
| `CHROME_PATH` | A Chrome/Chromium binary for demo verification. Without one, demo jobs fail with a clear message. |
| `SEARXNG_URL`, `SEARXNG_AUTH_HEADER` | SearXNG search; settable in the environment or in Settings → Providers → Search. The header is the full `Authorization` value (e.g. `Basic …`) and is never shown again. `TAVILY_API_KEY` / `BRAVE_API_KEY` work the same way. |

## SearXNG

- Enable JSON output in the instance's `settings.yml`: `search: formats: [html, json]`. Otherwise every search answers 403.
- The limiter (bot detection) can block or rate-limit (429) a server-side client. For a private instance, turn it off, or add the LearnHarness host to the limiter's pass list.
- Engines: Tavily, Brave and SearXNG. Each becomes live when its key (SearXNG: its URL) is set. With several set and no choice in Settings → Agent → Search engine, the order is Tavily → Brave → SearXNG; pick SearXNG there to keep searches on your own instance.
- With no engine configured, web search reports "not configured"; research still runs on pages it fetches directly.

## Backups

Back up `LH_DATA_DIR` and the folder holding `LH_AUTH_FILE` (it contains secrets — keep the copy private). Stop the service first, or copy twice and compare: files are rewritten whole, without locking. The library is your own content.

## Single instance

Run exactly one process per data folder. Jobs, compactions and the live-run registry live in that process's memory, and the stores rewrite whole JSON files without locking.

## Egress audit

`scripts/egress-audit.mjs` logs every outbound connection a Node process makes:

```bash
LH_EGRESS_LOG=/tmp/egress.jsonl NODE_OPTIONS="--import=/opt/learnharness/src/scripts/egress-audit.mjs" node server.js
node scripts/egress-audit.mjs summarize /tmp/egress.jsonl   # exit 1 if any external destination
```

Idle, the server makes none. Outbound traffic happens only when you cause it: model calls, web searches (to your SearXNG, or Tavily/Brave when chosen), pages the researcher fetches, and dictation (Deepgram, only with a key and only when you dictate).

## Pulling upstream releases

```bash
git remote add upstream https://github.com/amosblomqvist/learnharness.git   # once
git fetch upstream --tags
git checkout -b merge-vX.Y.Z && git merge vX.Y.Z
npm ci && npm run typecheck && npm test && npm run lint
```

Conflicts in deleted desktop files: `git rm` them again. Rebuild, then run the egress audit before deploying.

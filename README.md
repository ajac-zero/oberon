# Oberon

In *A Midsummer Night's Dream*, Oberon is the king Puck serves. Here, Oberon lets ChatGPT command [Amp](https://ampcode.com), whose assistant is Puck.

Oberon is an MCP server that connects ChatGPT to Amp. In ChatGPT it appears as **Amp**. ChatGPT can read your Amp threads, start and steer Amp agents, and get notified when an agent finishes, using [MCP Events](https://developers.openai.com/plugins/build/mcp-events).

```
┌─────────┐  MCP 2026-07-28 + OAuth   ┌────────────┐   amp CLI    ┌──────────────┐
│ ChatGPT │──────────────────────────▶│   Oberon   │─────────────▶│ Amp (orbs,   │
│         │◀──────────────────────────│            │◀─────────────│  runners)    │
└─────────┘  signed webhook events    └────────────┘ amp top      └──────────────┘
                                                     --stream-jsonl
```

## What ChatGPT gets

| Tool | Kind | What it does |
| --- | --- | --- |
| `search` | read | Search threads with Amp's query syntax (`repo:`, `author:me`, `after:7d`, …). |
| `fetch` | read | Read a thread as Markdown. Long threads keep the beginning and the end. |
| `list_active_threads` | read | Live status of active threads (working or idle, project). |
| `list_projects` | read | Amp projects to start orb threads in. |
| `start_thread` | write | Start an agent in an orb (`project`) or on a runner (`runner_id`, `runner_dir`). Returns immediately. |
| `send_message` | write | Send a follow-up message to an existing thread. Returns immediately. |
| `archive_thread` | write | Archive a thread, or unarchive it with `unarchive: true`. |

| Event | Filters | Payload |
| --- | --- | --- |
| `thread.turn_ended` | `thread_id`, `project` (both optional) | thread ID, title, URL, project, agent state, last agent message |

`search` and `fetch` use ChatGPT's standard company-knowledge shapes. Threads started by Oberon get the `chatgpt` label.

Example prompts in ChatGPT:

- "What did Amp do in the auth refactor this week?"
- "Start an Amp agent in ajac-zero/ai-gateway to fix the failing CI on main. When it finishes, review its summary and tell me whether it needs a follow-up."
- "Watch my amp-mcp project. Whenever an Amp agent finishes, add a one-line entry to my daily log."

## Run it

Requirements: Node 24+, and the Amp CLI logged in on the same machine (`amp login`, or `AMP_API_KEY` set to an access token).

```sh
npm install
cp .env.example .env   # set OBERON_PUBLIC_URL and OBERON_PASSPHRASE
npm start              # node --env-file=.env src/main.ts also works
```

ChatGPT needs a public HTTPS URL. For a quick test, use a Cloudflare quick tunnel and put its URL in `OBERON_PUBLIC_URL`:

```sh
cloudflared tunnel --url http://127.0.0.1:8787
```

Quick-tunnel URLs change on every restart, and ChatGPT stores the URL, so use a named tunnel or a real domain for anything lasting. [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) also works. Events only need outbound HTTPS from Oberon.

| Variable | Default | |
| --- | --- | --- |
| `OBERON_PUBLIC_URL` | required | Public HTTPS origin, no path. Also the OAuth issuer. |
| `OBERON_PASSPHRASE` | required | At least 12 characters. You type it once when linking ChatGPT. |
| `OBERON_PORT` / `OBERON_HOST` | `8787` / `127.0.0.1` | Bind address. Keep it on loopback behind a tunnel or proxy. |
| `OBERON_DATA_DIR` | `.data` | OAuth and subscription state (JSON, mode 0600). |
| `AMP_BIN` | `amp` | Amp CLI binary. |
| `OBERON_THREAD_LABEL` | `chatgpt` | Label added to threads the bridge starts. |

## Deploy to Fly.io

Oberon needs one process that is always running (the event watcher) and one volume (OAuth and subscription state). `fly.toml` configures a single Machine that never auto-stops, with a 1 GB volume at `/data`. The [Dockerfile](Dockerfile) installs the Amp CLI at build time with self-updates disabled; redeploy to update it. Oberon runs as the unprivileged `node` user.

The container authenticates to Amp with an access token from [Security Settings](https://ampcode.com/settings/security#access-token) (`sgamp_…`), not `amp login`. Per Amp's docs, runner threads are dispatched to the runner through Amp, so Oberon doesn't need to run on the runner's machine.

```sh
# 1. Pick a unique app name; update `app` and OBERON_PUBLIC_URL in fly.toml to match.
fly apps create my-oberon
fly volumes create oberon_data --region iad --size 1 --app my-oberon
# 2. Secrets (or set them in the Fly dashboard under Secrets)
fly secrets set --app my-oberon AMP_API_KEY=sgamp_… OBERON_PASSPHRASE='a long passphrase'
# 3. One Machine only: state lives on one volume
fly deploy --ha=false
```

The MCP server URL is then `https://my-oberon.fly.dev/mcp`.

## Connect ChatGPT

This repository is a plugin marketplace named `oberon`. It holds one plugin, `amp`, which appears in ChatGPT as **Amp**.

```
.agents/plugins/marketplace.json   marketplace catalog
plugins/amp/
  .codex-plugin/plugin.json        manifest (name, Amp display metadata, skills, MCP servers)
  .mcp.json                        the Oberon MCP server (https://oberon.fly.dev/mcp)
  skills/amp/SKILL.md              tells the model to delegate coding work to Amp's tools
  assets/amp-logo.png              Amp's app icon (from ampcode.com)
```

It uses the `.codex-plugin/plugin.json` + `.mcp.json` layout, not the newer portable `plugin.json` + `mcp.json`, because Codex 0.146 only loads MCP servers from the former.

`.mcp.json` sets `"omit_tools_from": ["deferred"]`. Without it, Codex 0.160 (and ChatGPT desktop) hides plugin MCP tools behind tool search. The model then doesn't know Amp has tools, so it reaches for computer use or a browser instead.

If your ChatGPT account also has a remote plugin named `amp` (for example, one created at chatgpt.com/plugins or by the plugin creator), delete it. Its `amp` server wins over this one, and this plugin's server is skipped as a duplicate.

1. Add the marketplace: `codex plugin marketplace add <owner>/<repo>` (or a local checkout path), then restart the ChatGPT desktop app.
2. In the desktop app's Plugins Directory, choose the **Oberon** marketplace and install **Amp**.
3. Sign in when asked. Oberon's consent page asks for your passphrase.
4. In a **Work** chat, ask for Amp (or type `@` and pick **Amp**).

Point `.mcp.json` at your own deployment if you run Oberon elsewhere.

## How it works

- **Protocol.** Oberon uses the v2 MCP TypeScript SDK (`2026-07-28`, `server/discover`). The SDK has no MCP Events support yet, so `events/list`, `events/subscribe`, and `events/unsubscribe` are custom request handlers, and `events: {}` is added to the server capabilities.
- **Event source.** `amp top --stream-jsonl` streams live thread state. A thread going from `working: true` to `working: false` is an ended turn. Oberon then waits for `amp threads export` to catch up and sends the final message. This usually takes a few seconds.
- **Delivery.** Each event is signed with [Standard Webhooks](https://www.standardwebhooks.com/) using the secret ChatGPT supplied. Transient failures are retried with backoff, keeping the same event ID. A `410` response removes the subscription. Callbacks must be HTTPS and resolve to public addresses; this is checked at connect time, and redirects are not followed. Callback URLs are verified with a challenge before a subscription is stored.
- **Subscriptions.** Subscription IDs are derived from the principal, callback URL, event name, and canonical arguments, so refreshes are idempotent. The default lifetime is 24 hours, clamped to between 1 hour and 7 days. During secret rotation, deliveries are signed with both secrets for an hour. State survives restarts.
- **Auth.** Oberon runs a built-in single-user OAuth 2.1 server: dynamic client registration, a passphrase consent page, PKCE S256 only, RFC 9207 `iss` on every redirect (not advertised in metadata, because Codex 0.146 and earlier reject servers that advertise it), tokens bound to the `/mcp` resource, single-use codes, rotating refresh tokens, and only SHA-256 hashes stored. After 10 wrong passphrases in 15 minutes, the consent page locks.

## Limitations

- Oberon drives the Amp CLI because Amp has no documented public HTTP API. `amp top --stream-jsonl` is marked experimental, so the event source may change.
- Events are not replayable (`cursor: null`). Turns that end while Oberon is down are not delivered.
- `start_thread` and `send_message` run as the Amp account the CLI is logged in as, and spend that account's credits. Anyone holding the passphrase can link a client.
- A ChatGPT task that messages the same thread it watches will loop. The server instructions tell ChatGPT not to do that unless you ask for it.

## Development

```sh
npm test          # node:test, including an end-to-end OAuth + MCP + events run against a fake Amp
npm run typecheck
```

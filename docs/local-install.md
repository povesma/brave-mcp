# Local Install And Smoke Test

This guide is for developers running the current repo directly.

## Prerequisites

- Node `22+`
- Brave browser
- an MCP-compatible agent, such as Claude Code or Codex

## 1. Build The Workspace

```sh
cd /path/to/brave-mcp

npm run build:protocol
npm run build:sdk
npm run build:daemon
npm run build:extension
npm run build:mcp
```

## 2. Start The Daemon

```sh
node apps/daemon/dist/index.js --port 39200
```

Or use the local launcher:

```sh
npm run launch:brave
```

The pairing secret is written to:

```text
~/.local/share/brave-mcp/daemon-config.json
```

The daemon, the MCP server, the workflow player and the launcher all use this folder
unless `BRAVE_MCP_CONFIG_DIR` (or the daemon's `--config-dir`) names another one. If
you change it, change it for all of them; otherwise they read different pairing secrets
and fail with "Invalid daemon auth token".

## 3. Load The Extension In Brave

1. Open `brave://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select `apps/extension/dist`
5. Open the extension options page
6. Set:
   - daemon URL: `ws://127.0.0.1:39200/extension/connect`
   - auth token: the `secret` from `daemon-config.json`
   - profile nickname: a short name for this profile, such as `Work`; required,
     and different in each profile that has the extension

If needed, click `Reconnect Now`. Repeat this step in every Brave profile the agent
should use.

## 4. Verify Bridge Health

```sh
curl -s http://127.0.0.1:39200/readyz | jq
```

Expected shape:

```json
{
  "ok": true,
  "ready": true,
  "extensionConnected": true,
  "paired": true,
  "profileCount": 1
}
```

## 5. Register The MCP Server With Your Agent

Claude Code (`-s user` makes the tools available in every project):

```sh
claude mcp add -s user brave-mcp -- node /absolute/path/to/apps/mcp/dist/index.js
```

Codex:

```sh
codex mcp add brave-mcp -- node /absolute/path/to/apps/mcp/dist/index.js
```

Then start a fresh agent session.

## 6. Smoke Test

Useful daemon checks:

```sh
curl -s http://127.0.0.1:39200/healthz | jq
curl -s http://127.0.0.1:39200/readyz | jq
```

Useful repo verifiers:

```sh
npm run verify:protocol
npm run verify:daemon
npm run verify:mcp
npm run verify:extension
```

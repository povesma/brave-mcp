# `install`

Installer and packaging area.

Current state:

- `brave-mcp-install.sh`
- `brave-mcp-install.ps1`
- `brave-mcp-install.mjs`

These scripts implement the current repo-local install flow. They build the local artifacts, create or reuse the daemon config directory, start the daemon, register the MCP server with Codex, run a health check, and try to open `brave://extensions` so the unpacked extension can be loaded.

The installer registers only with Codex so far. With Claude Code or another MCP agent, run it with `--skip-codex` and register the server yourself, as in step 5 of the [root README](../README.md#option-b-step-by-step).

Example usage:

```sh
./install/brave-mcp-install.sh
```

```powershell
powershell -File .\install\brave-mcp-install.ps1
```

Useful flags:

- `--config-dir <path>` to override the daemon config location
- `--skip-build` to reuse existing `dist` artifacts
- `--skip-codex` to avoid writing Codex MCP config (for Claude Code or another agent)
- `--skip-open` to avoid opening Brave automatically
- `--repair` to re-run registration and setup guidance for an existing install

Current limitation:

- the installer still targets the local repo build outputs and registers the Node entrypoint with Codex only
- packaged release downloads, OS service registration, and store-based extension distribution are still future work

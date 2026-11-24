# `apps/mcp`

The MCP server an agent starts. It offers the Brave tools over MCP (`stdio`), checks
their inputs against the shared protocol schemas, and forwards each call to the local
daemon.

- 48 browser tools, each with an optional `profile` input, plus `list_profiles`, which
  lists the nicknames of the connected Brave profiles.
- Daemon failures become tool errors that carry the daemon's error code. A profile error
  lists the connected nicknames.
- At start it finds the daemon and starts one if none answers. It refuses a daemon that
  reports no protocol version or an older one: an older daemon is still running and must
  be stopped first.

## Settings

All settings are environment variables of the registration.

| Variable | Meaning | Default |
|---|---|---|
| `BRAVE_MCP_DAEMON_URL` | Daemon address | `http://127.0.0.1:39200` |
| `BRAVE_MCP_CONFIG_DIR` | Folder holding `daemon-config.json` (the pairing secret) | `~/.local/share/brave-mcp` |
| `BRAVE_MCP_AUTH_TOKEN` | Pairing secret, used in place of the config file | — |
| `BRAVE_MCP_PROFILE` | Default profile nickname | — |
| `BRAVE_MCP_PROFILE_LOCK` | `1` or `true` locks the registration to the default profile | off |

### Default profile

With `BRAVE_MCP_PROFILE` set, a tool call without a `profile` runs in that profile, even
when several profiles are connected. A call naming another profile still runs there. If
the default profile is not connected, calls fail with "Profile <nickname> is offline";
they never fall back to another profile.

### Lock

With `BRAVE_MCP_PROFILE_LOCK=1` as well, the registration works in the default profile
only:

- a call naming any other profile is refused before it reaches the daemon, with a message
  that names only the locked profile;
- `list_profiles` shows only the locked profile;
- no error message names another profile.

A lock without a default profile, or an invalid nickname, stops the server at start.

The lock prevents mistakes by the agent. It is **not a security boundary**: any program
that can read the pairing secret can call the daemon directly and reach every connected
profile.

Example, a per-project Claude Code registration locked to the `Work` profile:

```sh
claude mcp add -s project brave-mcp -e BRAVE_MCP_PROFILE=Work -e BRAVE_MCP_PROFILE_LOCK=1 -- node /absolute/path/to/apps/mcp/dist/index.js
```

## Verify

```sh
npm run verify:mcp
```

It starts a daemon with two simulated profiles and checks the profile rules
(`src/verify-profiles.ts`), then plays every tool against a simulated extension, and
prints a JSON summary at the end. A run counts as passed only when that summary is
printed.

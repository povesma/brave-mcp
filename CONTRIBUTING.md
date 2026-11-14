# Contributing

The project rule is simple: do not mark a tool as implemented until the full stack exists.

For each tool, all four layers should be present:

- protocol schema
- daemon bridge support
- extension runtime support
- MCP exposure

And every completed tool should be verified through at least one of:

- the simulated bridge path
- a real Brave smoke test

## Development Notes

- Keep the daemon loopback-only.
- Prefer typed contracts over loose ad hoc payloads.
- Keep the MCP layer thin.
- Avoid adding browser-specific behavior directly into the MCP package.
- Do not expand the public tool list with flaky behavior just because the raw browser API exists.

## Nothing Private In Commits

This repository is public. `scripts/check-sanitized.mjs` checks what a commit
would publish and fails, with exit code 1, on:

- a file under a blocked path: `.env`, `tmp/`, `local/`, `.claude/`, `dist/`,
  `node_modules/`, or a key file;
- an added line in a common secret format: AWS key id, private key, GitHub,
  OpenAI, Slack or Google token, or a home-directory path;
- an added line containing, or an author email matching, any line of your
  own `.sanitize-patterns` file.

`.sanitize-patterns` is git-ignored and stays on your machine: one literal per
line (case does not matter; `#` starts a comment). List what must never be
published, such as account names and numbers, internal ids, and an email
address that must not appear as the commit author. The check prints only the
file, the commit and the pattern's name or line number, never the matched
text.

```sh
npm run check:sanitized                       # the staged changes
node scripts/check-sanitized.mjs --history    # every commit on every branch
npm run verify:sanitized                      # the check's own tests
```

To run it before every commit, turn on the repository's hooks once:

```sh
git config core.hooksPath .githooks
```

## Before Opening A PR

Run:

```sh
npm run verify:protocol
npm run verify:daemon
npm run verify:mcp
npm run verify:extension
```

If you change the public contract, also update:

- `specs/tools/brave-tools.schema.json`
- `specs/rpc/daemon-rpc.schema.json`
- `docs/tool-implementation-checklist.md`
- `README.md` if the visible surface changed

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

- a file under a blocked path: `.env`, `tmp/`, `local/`,
  `.claude/`, `dist/`, `node_modules/`, or a key file;
- an added line in a common secret format: AWS key id, private key, GitHub,
  OpenAI, Slack or Google token, or a home-directory path;
- an added line containing, or an author email matching, any line of your
  own private term list;
- anything your own local policy forbids.

Your private settings live in a `privacy/` folder inside the repository's
`.git` folder. Git never commits or pushes anything there, so no published
file shows what you keep private, and every worktree of the repository uses
the same copy. Create it once from the main working copy:

```sh
mkdir .git/privacy
```

- `.git/privacy/patterns` — your private term list: one literal per line (case
  does not matter; `#` starts a comment). List what must never be published,
  such as account names and numbers, internal ids, and an email address that
  must not appear as the commit author.
- `.git/privacy/policy` — your local policy:

  ```text
  allowed_remotes:
    - git@example.com:you/your-fork.git
  never_publish:
    - some/folder/
    - one/exact/file.txt
  author_email: *@users.noreply.github.com
  upstream_base: <hash of the last commit you did not write>
  ```

  A push is allowed only to a remote listed under `allowed_remotes`. A
  `never_publish` entry ending in `/` covers everything under that folder;
  any other entry is one exact file. `author_email` is the pattern every
  commit author must match (`*` stands for any text). `upstream_base` makes
  the history check skip commits you inherited.

To keep a folder of your own out of git without naming it in any published
file, add it to `.git/info/exclude`, git's local ignore list, instead of
`.gitignore`.

The check prints only the file, the commit and the pattern's name or line
number, never the matched text.

```sh
npm run check:sanitized                       # the staged changes
node scripts/check-sanitized.mjs --history    # every commit on every branch
npm run verify:sanitized                      # the check's own tests
```

To run it before every commit and every push, turn on the repository's
hooks once:

```sh
git config core.hooksPath .githooks
```

With the hooks on and no local policy, or a remote not listed in it,
every push is refused. The general rules are in [PRIVACY.md](PRIVACY.md).

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

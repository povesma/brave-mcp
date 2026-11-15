# Privacy Policy

This file holds the general rules only. It deliberately lists no folder,
file, remote or term that is kept private: a published list of what is
hidden would itself disclose it. Those lists live in the untracked
`.private/` folder of each working copy (see
[CONTRIBUTING.md](CONTRIBUTING.md), "Nothing Private In Commits").

## Rules

- **Everything pushed is public.** A pushed commit stays reachable by its
  hash after its branch is deleted or rewritten, and only GitHub Support can
  remove it. Nothing private may enter a commit.
- **Private settings are never committed.** The allowed remotes, the
  never-published paths, the required author email and the private term
  list are read from `.private/`, which ignores itself. The check refuses
  any commit that contains a `.private/` path.
- **Never published.** Planning notes, personal scripts, and anything
  describing a person's own logins or workflows: sign-in addresses, calls
  to personal tools, account names or numbers.
- **Author email.** Every commit uses the address pattern set in the local
  policy. Commits inherited from the original project keep their authors.
- **Checks.** Before each commit: `npm run check:sanitized`. Before each
  push: the pre-push hook checks exactly the commits being sent, and
  refuses when there is no local policy or the remote is not listed in it.
  History: `node scripts/check-sanitized.mjs --history`. Turn the hooks on
  once with `git config core.hooksPath .githooks`.
- **Pushes.** Each push needs the owner's explicit instruction naming the
  remote and branch, after being shown the remote, visibility, branch,
  commits and changed files.

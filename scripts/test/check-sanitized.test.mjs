import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "check-sanitized.mjs");
const AUTHOR = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "ok@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "ok@example.test" };

// Built at run time so this file never holds a value the check would flag.
const FAKE_AWS_KEY = "AKIA" + "Q".repeat(16);
const LOCAL_SECRET = "acme" + "-internal-profile";

let counter = 0;

async function repo(files, { patterns } = {}) {
  counter += 1;
  const dir = join(ROOT, "tmp", `check-sanitized-${process.pid}-${counter}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  if (patterns !== undefined) {
    await local(dir, "patterns", patterns);
  }
  await stage(dir, files);
  return dir;
}

// Local-only files live in the git directory, which git never commits or pushes.
async function local(dir, name, text) {
  await mkdir(join(dir, ".git", "privacy"), { recursive: true });
  await writeFile(join(dir, ".git", "privacy", name), text);
}

async function stage(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), text);
    git(dir, ["add", "-f", name]);
  }
}

function git(dir, args, env = {}) {
  const result = spawnSync("git", args, { cwd: dir, env: { ...process.env, ...AUTHOR, ...env }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function check(dir, args = [], env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    env: { ...process.env, ...AUTHOR, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: result.status, output: result.stdout + result.stderr };
}

async function withRepo(files, options, body) {
  const dir = await repo(files, options);
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("clean staged changes pass and print one progress line per step", async () => {
  await withRepo({ "src/a.ts": "export const a = 1;\n" }, {}, async (dir) => {
    const { code, output } = check(dir);

    assert.equal(code, 0, output);
    assert.match(output, /\[check-sanitized\] .* \(\d+\.\d s\)/);
    assert.match(output, /no problems found/);
  });
});

test("a staged file under a blocked path fails and names the file", async () => {
  await withRepo({ ".env": "X=1\n", "apps/x/local/run.yaml": "a: 1\n" }, {}, async (dir) => {
    const { code, output } = check(dir);

    assert.equal(code, 1, output);
    assert.match(output, /\.env: blocked path/);
    assert.match(output, /apps\/x\/local\/run\.yaml: blocked path/);
  });
});

test("a linked worktree uses the local files of its main repository", async () => {
  await withRepo({ "src/a.ts": "export const a = 1;\n" }, { patterns: `${LOCAL_SECRET}\n` }, async (dir) => {
    git(dir, ["commit", "-q", "-m", "first"]);
    const worktree = `${dir}-worktree`;
    git(dir, ["worktree", "add", "-q", worktree]);
    try {
      await stage(worktree, { "src/b.ts": `// ${LOCAL_SECRET}\n` });

      const { code, output } = check(worktree);

      assert.equal(code, 1, output);
      assert.match(output, /src\/b\.ts: local patterns line 1/);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });
});

test("files in a .private/ folder of the working tree are not read", async () => {
  await withRepo({ "src/a.ts": `// ${LOCAL_SECRET}\n` }, {}, async (dir) => {
    await mkdir(join(dir, ".private"), { recursive: true });
    await writeFile(join(dir, ".private", "patterns"), `${LOCAL_SECRET}\n`);

    const { code, output } = check(dir);

    assert.equal(code, 0, output);
    assert.match(output, /0 local pattern\(s\)/);
  });
});

test("a secret format in an added line fails, naming the pattern but never printing the value", async () => {
  await withRepo({ "src/config.ts": `const key = "${FAKE_AWS_KEY}";\n` }, {}, async (dir) => {
    const { code, output } = check(dir);

    assert.equal(code, 1, output);
    assert.match(output, /src\/config\.ts: aws-access-key-id/);
    assert.ok(!output.includes(FAKE_AWS_KEY));
  });
});

test("a literal from the local pattern file fails, naming its line number but never printing it", async () => {
  await withRepo(
    { "docs/notes.md": `run with --profile ${LOCAL_SECRET.toUpperCase()}\n` },
    { patterns: `# local identifiers\n\n${LOCAL_SECRET}\n` },
    async (dir) => {
      const { code, output } = check(dir);

      assert.equal(code, 1, output);
      assert.match(output, /docs\/notes\.md: local patterns line 3/);
      assert.ok(!output.toLowerCase().includes(LOCAL_SECRET));
    },
  );
});

test("an author email listed in the local pattern file fails the commit", async () => {
  await withRepo({ "src/a.ts": "export const a = 1;\n" }, { patterns: "wrong@corp.test\n" }, async (dir) => {
    const { code, output } = check(dir, [], { GIT_AUTHOR_EMAIL: "wrong@corp.test" });

    assert.equal(code, 1, output);
    assert.match(output, /author email matches local patterns line 1/);
    assert.ok(!output.includes("wrong@corp.test"));
  });
});

test("a line that is only removed does not count", async () => {
  await withRepo({ "src/a.ts": `// ${LOCAL_SECRET}\n` }, {}, async (dir) => {
    git(dir, ["commit", "-q", "-m", "first"]);
    await local(dir, "patterns", `${LOCAL_SECRET}\n`);
    await stage(dir, { "src/a.ts": "// clean\n" });

    const { code, output } = check(dir);

    assert.equal(code, 0, output);
  });
});

test("--history finds a match in an earlier commit and names the commit", async () => {
  await withRepo({ "src/a.ts": `const key = "${FAKE_AWS_KEY}";\n` }, {}, async (dir) => {
    git(dir, ["commit", "-q", "-m", "leak"]);
    const hash = git(dir, ["rev-parse", "--short", "HEAD"]).trim();
    await stage(dir, { "src/a.ts": "const key = process.env.KEY;\n" });
    git(dir, ["commit", "-q", "-m", "fix"]);

    const { code, output } = check(dir, ["--history"]);

    assert.equal(code, 1, output);
    assert.match(output, new RegExp(`${hash} src/a\\.ts: aws-access-key-id`));
    assert.ok(!output.includes(FAKE_AWS_KEY));
  });
});

function policy({ remotes = [], never = [], email = "*@example.test" } = {}) {
  return [
    "# local privacy policy",
    "visibility: private",
    "allowed_remotes:",
    ...remotes.map((remote) => `  - ${remote}`),
    "never_publish:",
    ...never.map((path) => `  - ${path}`),
    `author_email: ${email}`,
    "",
  ].join("\n");
}

function prePush(dir, url, lines) {
  const result = spawnSync(process.execPath, [SCRIPT, "--pre-push", url], {
    cwd: dir,
    env: { ...process.env, ...AUTHOR },
    input: lines,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: result.status, output: result.stdout + result.stderr };
}

async function withRemote(files, body) {
  await withRepo(files, {}, async (dir) => {
    const remote = join(dir, "..", `${dir.split("/").pop()}-remote.git`);
    await rm(remote, { recursive: true, force: true });
    spawnSync("git", ["init", "-q", "--bare", remote]);
    try {
      await body(dir, remote);
    } finally {
      await rm(remote, { recursive: true, force: true });
    }
  });
}

function outgoing(dir) {
  const sha = git(dir, ["rev-parse", "HEAD"]).trim();
  return `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`;
}

test("--pre-push fails when the repository has no local policy", async () => {
  await withRemote({ "src/a.ts": "export const a = 1;\n" }, async (dir, remote) => {
    git(dir, ["commit", "-q", "-m", "first"]);

    const { code, output } = prePush(dir, remote, outgoing(dir));

    assert.equal(code, 1, output);
    assert.match(output, /no local policy/);
  });
});

test("--pre-push fails for a remote not listed in allowed_remotes", async () => {
  await withRemote({ "src/a.ts": "export const a = 1;\n" }, async (dir, remote) => {
    await local(dir, "policy", policy({ remotes: ["git@example.test:me/other.git"] }));
    git(dir, ["commit", "-q", "-m", "first"]);

    const { code, output } = prePush(dir, remote, outgoing(dir));

    assert.equal(code, 1, output);
    assert.match(output, /remote is not in allowed_remotes/);
  });
});

test("--pre-push fails when an outgoing commit adds a never_publish path", async () => {
  await withRemote({ "notes/plan.md": "plan\n" }, async (dir, remote) => {
    await local(dir, "policy", policy({ remotes: [remote], never: ["notes/"] }));
    git(dir, ["commit", "-q", "-m", "first"]);

    const { code, output } = prePush(dir, remote, outgoing(dir));

    assert.equal(code, 1, output);
    assert.match(output, /notes\/plan\.md: never_publish path/);
  });
});

test("--pre-push checks only commits the remote does not have yet", async () => {
  await withRemote({ "src/a.ts": `// ${LOCAL_SECRET}\n` }, async (dir, remote) => {
    await local(dir, "policy", policy({ remotes: [remote] }));
    git(dir, ["commit", "-q", "-m", "first"]);
    git(dir, ["push", "-q", remote, "HEAD:refs/heads/main"]);
    git(dir, ["fetch", "-q", remote, "+refs/heads/*:refs/remotes/origin/*"]);
    await local(dir, "patterns", `${LOCAL_SECRET}\n`);
    await stage(dir, { "src/b.ts": "export const b = 2;\n" });
    git(dir, ["commit", "-q", "-m", "second"]);

    const { code, output } = prePush(dir, remote, outgoing(dir));

    assert.equal(code, 0, output);
    assert.match(output, /no problems found/);
  });
});

test("--pre-push replacing a remote commit that is not present locally still checks the outgoing commits", async () => {
  await withRemote({ "src/a.ts": `// ${LOCAL_SECRET}\n` }, async (dir, remote) => {
    await local(dir, "policy", policy({ remotes: [remote] }));
    await local(dir, "patterns", `${LOCAL_SECRET}\n`);
    git(dir, ["commit", "-q", "-m", "first"]);
    const sha = git(dir, ["rev-parse", "HEAD"]).trim();
    const unknownRemoteSha = "1".repeat(40);

    const { code, output } = prePush(dir, remote, `refs/heads/main ${sha} refs/heads/main ${unknownRemoteSha}\n`);

    assert.equal(code, 1, output);
    assert.match(output, /src\/a\.ts: local patterns line 1/);
    assert.doesNotMatch(output, /git log failed/);
  });
});

test("--pre-push reports an outgoing author email that the local policy does not allow", async () => {
  await withRemote({ "src/a.ts": "export const a = 1;\n" }, async (dir, remote) => {
    await local(dir, "policy", policy({ remotes: [remote], email: "*@users.noreply.github.com" }));
    git(dir, ["commit", "-q", "-m", "first"]);

    const { code, output } = prePush(dir, remote, outgoing(dir));

    assert.equal(code, 1, output);
    assert.match(output, /author email does not match author_email of the local policy/);
    assert.ok(!output.includes("ok@example.test"));
  });
});

test("staged changes under a never_publish path from the local policy fail", async () => {
  await withRepo({ "notes/plan.md": "x\n" }, {}, async (dir) => {
    await local(dir, "policy", policy({ never: ["notes/"] }));
    const { code, output } = check(dir);

    assert.equal(code, 1, output);
    assert.match(output, /notes\/plan\.md: never_publish path/);
  });
});

test("--history skips commits reachable from upstream_base in the local policy", async () => {
  await withRepo({ "src/a.ts": "export const a = 1;\n" }, {}, async (dir) => {
    git(dir, ["commit", "-q", "-m", "upstream"], { GIT_AUTHOR_EMAIL: "someone@else.test" });
    const base = git(dir, ["rev-parse", "HEAD"]).trim();
    await local(dir, "policy", policy({ email: "*@example.test" }).replace("visibility: private", `visibility: private\nupstream_base: ${base}`));
    await stage(dir, { "src/b.ts": "export const b = 2;\n" });
    git(dir, ["commit", "-q", "-m", "mine"]);

    const { code, output } = check(dir, ["--history"]);

    assert.equal(code, 0, output);
    assert.match(output, /no problems found/);
  });
});

test("--history checks every commit's author email", async () => {
  await withRepo({ "src/a.ts": "export const a = 1;\n" }, { patterns: "wrong@corp.test\n" }, async (dir) => {
    git(dir, ["commit", "-q", "-m", "first"], { GIT_AUTHOR_EMAIL: "wrong@corp.test" });
    const hash = git(dir, ["rev-parse", "--short", "HEAD"]).trim();

    const { code, output } = check(dir, ["--history"]);

    assert.equal(code, 1, output);
    assert.match(output, new RegExp(`${hash}: author email matches local patterns line 1`));
  });
});

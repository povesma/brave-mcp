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
    await writeFile(join(dir, ".sanitize-patterns"), patterns);
    await writeFile(join(dir, ".gitignore"), ".sanitize-patterns\n");
  }
  await stage(dir, files);
  return dir;
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

test("a secret format in an added line fails, naming the pattern but never printing the value", async () => {
  await withRepo({ "src/config.ts": `const key = "${FAKE_AWS_KEY}";\n` }, {}, async (dir) => {
    const { code, output } = check(dir);

    assert.equal(code, 1, output);
    assert.match(output, /src\/config\.ts: aws-access-key-id/);
    assert.ok(!output.includes(FAKE_AWS_KEY));
  });
});

test("a literal from .sanitize-patterns fails, naming its line number but never printing it", async () => {
  await withRepo(
    { "docs/notes.md": `run with --profile ${LOCAL_SECRET.toUpperCase()}\n` },
    { patterns: `# local identifiers\n\n${LOCAL_SECRET}\n` },
    async (dir) => {
      const { code, output } = check(dir);

      assert.equal(code, 1, output);
      assert.match(output, /docs\/notes\.md: \.sanitize-patterns line 3/);
      assert.ok(!output.toLowerCase().includes(LOCAL_SECRET));
    },
  );
});

test("an author email listed in .sanitize-patterns fails the commit", async () => {
  await withRepo({ "src/a.ts": "export const a = 1;\n" }, { patterns: "wrong@corp.test\n" }, async (dir) => {
    const { code, output } = check(dir, [], { GIT_AUTHOR_EMAIL: "wrong@corp.test" });

    assert.equal(code, 1, output);
    assert.match(output, /author email matches \.sanitize-patterns line 1/);
    assert.ok(!output.includes("wrong@corp.test"));
  });
});

test("a line that is only removed does not count", async () => {
  await withRepo({ "src/a.ts": `// ${LOCAL_SECRET}\n` }, {}, async (dir) => {
    git(dir, ["commit", "-q", "-m", "first"]);
    await writeFile(join(dir, ".sanitize-patterns"), `${LOCAL_SECRET}\n`);
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

test("--history checks every commit's author email", async () => {
  await withRepo({ "src/a.ts": "export const a = 1;\n" }, { patterns: "wrong@corp.test\n" }, async (dir) => {
    git(dir, ["commit", "-q", "-m", "first"], { GIT_AUTHOR_EMAIL: "wrong@corp.test" });
    const hash = git(dir, ["rev-parse", "--short", "HEAD"]).trim();

    const { code, output } = check(dir, ["--history"]);

    assert.equal(code, 1, output);
    assert.match(output, new RegExp(`${hash}: author email matches \\.sanitize-patterns line 1`));
  });
});

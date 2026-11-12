import assert from "node:assert/strict";
import { mkdir, readdir, rm } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { cmd, startTestServer } from "./engine-helpers.js";
import { daemonEnv, removeScript, startHarness, until, writeScript, type HarnessRun } from "./entry-helpers.js";
import { FakeDaemon } from "./fake-daemon.js";

const TAB_INFO = {
  result: {
    tab: {
      tabId: 41,
      windowId: 1,
      title: "Sign in page",
      url: "https://example.test/login?session=query-value#fragment-value",
      active: true,
    },
  },
};

function prepareDaemon(daemon: FakeDaemon): void {
  daemon.reply("tabs.open", { result: { tabId: 41 } });
  daemon.fallback("tabs.getInfo", TAB_INFO);
  daemon.fallback("dom.type", (params) => ({ result: { typed: params.selector === "#right" } }));
  daemon.fallback("dom.click", (params) => ({ result: { clicked: params.selector === "#right" } }));
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

async function paused(run: HarnessRun, times = 1): Promise<void> {
  await until(() => occurrences(run.output(), "to resume:") >= times, `pause report number ${times}`);
}

async function withPausedRun(
  name: string,
  yaml: string,
  body: (context: { run: HarnessRun; daemon: FakeDaemon; rewrite: (yaml: string) => Promise<void> }) => Promise<void>,
  options: { env?: Record<string, string>; cwd?: string } = {},
): Promise<void> {
  const daemon = await FakeDaemon.start();
  const scriptPath = await writeScript(name, yaml);
  prepareDaemon(daemon);
  const run = startHarness([scriptPath], { ...daemonEnv(daemon), ...options.env }, options.cwd);
  try {
    await body({ run, daemon, rewrite: async (text) => void (await writeScript(name, text)) });
  } finally {
    run.child.kill("SIGKILL");
    await run.finished;
    await removeScript(scriptPath);
    await daemon.stop();
  }
}

function clickScript(selector: string, firstUrl = "https://example.test/login"): string {
  return `
name: pause-on-click
pause_timeout_s: 20
steps:
  - open_tab: { url: "${firstUrl}" }
  - run: { cmd: ${cmd("print-value", "s3cret-value")}, capture: secret }
  - start: { id: helper, cmd: ${cmd("sleep", "60")} }
  - type: { selector: "#right", text: "\${secret}" }
  - click: { selector: "${selector}", on_failure: { then: pause } }
`;
}

test("a failed step with then: pause keeps the process running, reports safely, and resumes on SIGUSR2", async () => {
  await withPausedRun("pause-resume", clickScript("#wrong"), async ({ run, daemon, rewrite }) => {
    await paused(run);

    assert.equal(run.child.exitCode, null, "the process must still be running");
    const report = run.output();
    assert.match(report, /paused at step 5 \(click\): NOT_CLICKED/);
    assert.match(report, /tab address: https:\/\/example\.test\/login$/m);
    assert.match(report, /tab title: Sign in page$/m);
    assert.match(report, /background commands still running: helper$/m);
    assert.ok(!report.includes("query-value") && !report.includes("fragment-value"));
    assert.ok(!report.includes("s3cret-value"));

    await rewrite(clickScript("#right"));
    run.child.kill("SIGUSR2");
    const result = await run.finished;

    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /resumed at step 5/);
    assert.ok(!(result.stdout + result.stderr).includes("s3cret-value"));
    assert.deepEqual(
      daemon.callsTo("dom.click").map((call) => call.params.selector),
      ["#wrong", "#right"],
    );
  });
});

test("a resume is refused while the played steps differ or the script is invalid, and the pause continues", async () => {
  await withPausedRun("pause-refused", clickScript("#wrong"), async ({ run, rewrite }) => {
    await paused(run);

    await rewrite(clickScript("#right", "https://example.test/changed"));
    run.child.kill("SIGUSR2");
    await until(() => run.output().includes("differ from those already played; still paused"), "the first refusal");
    assert.equal(run.child.exitCode, null);

    await rewrite("name: broken\nsteps:\n  - click: {}\n");
    run.child.kill("SIGUSR2");
    await until(() => run.output().includes("the script file is invalid; still paused"), "the second refusal");
    assert.equal(run.child.exitCode, null);

    await rewrite(clickScript("#right"));
    run.child.kill("SIGUSR2");
    const result = await run.finished;

    assert.equal(result.code, 0, result.stdout + result.stderr);
  });
});

test("before the retry, each earlier run step whose variable the stuck step uses is run again", async () => {
  const codes = await startTestServer((hit) => ({ body: `code-${hit}` }));
  const other = await startTestServer((hit) => ({ body: `other-${hit}` }));
  const script = (selector: string): string => `
name: pause-recapture
pause_timeout_s: 20
steps:
  - open_tab: { url: "https://example.test/login" }
  - run: { cmd: ${cmd("fetch-url", other.url)}, capture: unused }
  - run: { cmd: ${cmd("fetch-url", codes.url)}, capture: code }
  - type: { selector: "${selector}", text: "\${code}", on_failure: { then: pause } }
`;
  try {
    await withPausedRun("pause-recapture", script("#wrong"), async ({ run, daemon, rewrite }) => {
      await paused(run);

      await rewrite(script("#right"));
      run.child.kill("SIGUSR2");
      const result = await run.finished;

      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.deepEqual(
        daemon.callsTo("dom.type").map((call) => [call.params.selector, call.params.text]),
        [
          ["#wrong", "code-1"],
          ["#right", "code-2"],
        ],
      );
      assert.equal(codes.hits.length, 2);
      assert.equal(other.hits.length, 1);
      assert.ok(!(result.stdout + result.stderr).includes("code-"));
    });
  } finally {
    await codes.stop();
    await other.stop();
  }
});

test("a resume fails when the stuck step uses a value from a background command that has exited", async () => {
  const script = `
name: pause-stale
pause_timeout_s: 20
steps:
  - open_tab: { url: "https://example.test/login" }
  - start: { id: cli, cmd: ${cmd("url-then-wait")}, capture_match: { var: url, pattern: "http://127\\\\.0\\\\.0\\\\.1:\\\\d+/callback\\\\S*" }, timeout_s: 10 }
  - run: { cmd: ${cmd("fetch-url", "${url}")} }
  - await: { id: cli, timeout_s: 10 }
  - type: { selector: "#wrong", text: "\${url}", on_failure: { then: pause } }
`;
  await withPausedRun("pause-stale", script, async ({ run }) => {
    await paused(run);
    assert.match(run.output(), /background commands still running: none$/m);

    run.child.kill("SIGUSR2");
    const result = await run.finished;

    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /resume failed: step 5 uses a value captured from background command "cli", which has exited/);
  });
});

test("the pause time limit ends the run with exit code 1", async () => {
  const script = clickScript("#wrong").replace("pause_timeout_s: 20", "pause_timeout_s: 0.4");
  await withPausedRun("pause-time-limit", script, async ({ run }) => {
    const result = await run.finished;

    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /pause time limit of 0\.4 s reached/);
    assert.match(result.stderr, /failed at step 5 \(PAUSE_TIME_LIMIT\)/);
  });
});

test("a paused and resumed run leaves no new file in the working directory or the temp directory", async () => {
  const workDir = fileURLToPath(new URL("../../tmp/empty-work-dir", import.meta.url));
  const tempDir = fileURLToPath(new URL("../../tmp/empty-temp-dir", import.meta.url));
  for (const dir of [workDir, tempDir]) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
  }

  await withPausedRun(
    "pause-no-files",
    clickScript("#wrong"),
    async ({ run, rewrite }) => {
      await paused(run);
      await rewrite(clickScript("#right"));
      run.child.kill("SIGUSR2");
      const result = await run.finished;

      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.deepEqual(await readdir(workDir), []);
      assert.deepEqual(await readdir(tempDir), []);
    },
    { env: { TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir }, cwd: workDir },
  );
});

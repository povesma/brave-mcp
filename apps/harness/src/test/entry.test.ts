import assert from "node:assert/strict";
import { test } from "node:test";

import { cmd, startTestServer } from "./engine-helpers.js";
import { daemonEnv, processIsAlive, removeScript, runHarness, startHarness, until, writeScript } from "./entry-helpers.js";
import { FakeDaemon } from "./fake-daemon.js";

const TWO_STEPS = `
name: two-steps
steps:
  - open_tab: { url: "https://example.test/" }
  - click: { selector: "#go" }
`;

async function withScript(
  name: string,
  yaml: string,
  run: (scriptPath: string, daemon: FakeDaemon) => Promise<void>,
): Promise<void> {
  const daemon = await FakeDaemon.start();
  const scriptPath = await writeScript(name, yaml);
  try {
    await run(scriptPath, daemon);
  } finally {
    await removeScript(scriptPath);
    await daemon.stop();
  }
}

function scriptedOk(daemon: FakeDaemon): void {
  daemon.reply("tabs.open", { result: { tabId: 41 } });
  daemon.reply("dom.click", { result: { clicked: true } });
}

test("no script path prints a usage line and exits with code 2", async () => {
  const result = await runHarness([]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /^Usage: brave-mcp-play <script\.yaml>$/m);
  assert.equal(result.stdout, "");
});

test("exit 0: the script completed", async () => {
  await withScript("completed", TWO_STEPS, async (scriptPath, daemon) => {
    scriptedOk(daemon);

    const result = await runHarness([scriptPath], daemonEnv(daemon));

    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(daemon.calls.length, 2);
    assert.match(result.stdout, /step 2\/2 click: ok/);
  });
});

test("exit 1: a step failed", async () => {
  await withScript("step-failed", TWO_STEPS, async (scriptPath, daemon) => {
    daemon.reply("tabs.open", { result: { tabId: 41 } });
    daemon.reply("dom.click", { result: { clicked: false } });

    const result = await runHarness([scriptPath], daemonEnv(daemon));

    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /failed at step 2 \(NOT_CLICKED\)/);
  });
});

test("exit 2: an invalid script is rejected with its step number and no daemon call", async () => {
  const invalid = `name: invalid\nsteps:\n  - click: { selector: "#go" }\n`;
  await withScript("invalid", invalid, async (scriptPath, daemon) => {
    const result = await runHarness([scriptPath], daemonEnv(daemon));

    assert.equal(result.code, 2);
    assert.match(result.stderr, /step 1: /);
    assert.equal(daemon.calls.length, 0);
  });
});

test("exit 3: the daemon is unreachable", async () => {
  await withScript("unreachable", TWO_STEPS, async (scriptPath, daemon) => {
    const env = daemonEnv(daemon);
    await daemon.stop();

    const result = await runHarness([scriptPath], env);

    assert.equal(result.code, 3, result.stdout + result.stderr);
  });
});

test("exit 3: the extension is not connected at start", async () => {
  await withScript("not-connected", TWO_STEPS, async (scriptPath, daemon) => {
    daemon.extensionConnected = false;

    const result = await runHarness([scriptPath], daemonEnv(daemon));

    assert.equal(result.code, 3, result.stdout + result.stderr);
    assert.equal(daemon.calls.length, 0);
  });
});

test("exit 3: the daemon answers auth required", async () => {
  await withScript("auth-required", TWO_STEPS, async (scriptPath, daemon) => {
    daemon.reply("tabs.open", { error: { code: "BRAVE_AUTH_REQUIRED" } });

    const result = await runHarness([scriptPath], daemonEnv(daemon));

    assert.equal(result.code, 3, result.stdout + result.stderr);
  });
});

test("exit 3: extension offline reply while readiness shows not connected", async () => {
  await withScript("offline-disconnected", TWO_STEPS, async (scriptPath, daemon) => {
    daemon.reply("tabs.open", () => {
      daemon.extensionConnected = false;
      return { error: { code: "BRAVE_EXTENSION_OFFLINE" } };
    });

    const result = await runHarness([scriptPath], daemonEnv(daemon));

    assert.equal(result.code, 3, result.stdout + result.stderr);
  });
});

test("exit 1: extension offline reply while readiness shows connected is a step failure", async () => {
  await withScript("offline-connected", TWO_STEPS, async (scriptPath, daemon) => {
    daemon.reply("tabs.open", { error: { code: "BRAVE_EXTENSION_OFFLINE" } });

    const result = await runHarness([scriptPath], daemonEnv(daemon));

    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /failed at step 1 \(BRAVE_EXTENSION_OFFLINE\)/);
  });
});

test("exit 10: the precondition command exits 0, and no step runs", async () => {
  const yaml = `name: satisfied\nprecondition:\n  cmd: ${cmd("exit-with", "0")}\nsteps:\n  - open_tab: { url: "https://example.test/" }\n`;
  await withScript("precondition-passed", yaml, async (scriptPath, daemon) => {
    const result = await runHarness([scriptPath], daemonEnv(daemon));

    assert.equal(result.code, 10, result.stdout + result.stderr);
    assert.equal(daemon.calls.length, 0);
    assert.ok(!result.stdout.includes("stand-in"));
  });
});

test("the steps run when the precondition command exits non-zero", async () => {
  const yaml = `name: unsatisfied\nprecondition:\n  cmd: ${cmd("exit-with", "1")}\nsteps:\n  - open_tab: { url: "https://example.test/" }\n  - click: { selector: "#go" }\n`;
  await withScript("precondition-failed", yaml, async (scriptPath, daemon) => {
    scriptedOk(daemon);

    const result = await runHarness([scriptPath], daemonEnv(daemon));

    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(daemon.calls.length, 2);
  });
});

test("the daemon token is never printed", async () => {
  await withScript("token", TWO_STEPS, async (scriptPath, daemon) => {
    daemon.reply("tabs.open", { error: { code: "BRAVE_INTERNAL_ERROR", message: `token ${daemon.token}` } });

    const result = await runHarness([scriptPath], daemonEnv(daemon));

    assert.equal(result.code, 1);
    assert.ok(!(result.stdout + result.stderr).includes(daemon.token));
  });
});

function pidsOf(hits: string[]): number[] {
  return hits.map((hit) => Number(new URL(hit, "http://localhost").searchParams.get("pid")));
}

test("background commands end when the script completes", async () => {
  const server = await startTestServer(() => ({ body: "ok" }));
  const yaml = `name: bg-normal\nsteps:\n  - start: { id: bg, cmd: ${cmd("announce-then-sleep", server.url, "60")} }\n  - run: { cmd: ${cmd("fetch-url", `${server.url}/reached`)} }\n`;
  try {
    await withScript("bg-normal", yaml, async (scriptPath, daemon) => {
      const run = startHarness([scriptPath], daemonEnv(daemon));
      await until(() => server.hits.some((hit) => hit.includes("pid=")), "the background command to announce itself");
      const result = await run.finished;

      assert.equal(result.code, 0, result.stdout + result.stderr);
      const [pid] = pidsOf(server.hits.filter((hit) => hit.includes("pid=")));
      assert.ok(pid !== undefined && pid > 0);
      assert.equal(processIsAlive(pid), false);
    });
  } finally {
    await server.stop();
  }
});

for (const [signal, exitCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  test(`${signal} ends the background and the running command, then the harness`, async () => {
    const server = await startTestServer(() => ({ body: "ok" }));
    const yaml = `name: bg-signal\nsteps:\n  - start: { id: bg, cmd: ${cmd("announce-then-sleep", server.url, "60")} }\n  - run: { cmd: ${cmd("announce-then-sleep", server.url, "60")}, timeout_s: 60 }\n`;
    try {
      await withScript(`bg-${signal}`, yaml, async (scriptPath, daemon) => {
        const run = startHarness([scriptPath], daemonEnv(daemon));
        await until(() => server.hits.length >= 2, "both commands to announce themselves");

        run.child.kill(signal);
        const result = await run.finished;

        assert.equal(result.code, exitCode, result.stdout + result.stderr);
        const pids = pidsOf(server.hits);
        assert.equal(pids.length, 2);
        for (const pid of pids) {
          assert.equal(processIsAlive(pid), false);
        }
      });
    } finally {
      await server.stop();
    }
  });
}

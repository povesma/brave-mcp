import assert from "node:assert/strict";
import { test } from "node:test";

import { DaemonClient, DaemonUnavailableError } from "../daemon-client.js";
import { daemonEnv, removeScript, runHarness, writeScript } from "./entry-helpers.js";
import { FakeDaemon } from "./fake-daemon.js";

const TWO_STEPS = `
name: two-steps
steps:
  - open_tab: { url: "https://example.test/" }
  - click: { selector: "#go" }
`;

async function withDaemon(run: (daemon: FakeDaemon) => Promise<void>): Promise<void> {
  const daemon = await FakeDaemon.start();
  try {
    await run(daemon);
  } finally {
    await daemon.stop();
  }
}

async function withScript(name: string, run: (scriptPath: string, daemon: FakeDaemon) => Promise<void>) {
  const daemon = await FakeDaemon.start();
  const scriptPath = await writeScript(name, TWO_STEPS);
  try {
    daemon.reply("tabs.open", { result: { tabId: 41 } });
    daemon.reply("dom.click", { result: { clicked: true } });
    await run(scriptPath, daemon);
  } finally {
    await removeScript(scriptPath);
    await daemon.stop();
  }
}

function profilesOf(daemon: FakeDaemon): Array<string | undefined> {
  return daemon.calls.map((call) => call.profile);
}

test("every request carries the chosen profile, including tabs.open and tabs.list", async () => {
  await withDaemon(async (daemon) => {
    daemon.reply("tabs.open", { result: { tabId: 41 } });
    daemon.reply("tabs.list", { result: { tabs: [] } });
    const client = new DaemonClient({ daemonUrl: daemon.url, authToken: daemon.token }, { profile: "Work" });

    await client.call("tabs.open", { url: "https://example.test/" });
    await client.call("tabs.list", {});

    assert.deepEqual(profilesOf(daemon), ["Work", "Work"]);
  });
});

test("without a chosen profile the request carries none", async () => {
  await withDaemon(async (daemon) => {
    daemon.reply("tabs.list", { result: { tabs: [] } });
    const client = new DaemonClient({ daemonUrl: daemon.url, authToken: daemon.token });

    await client.call("tabs.list", {});

    assert.deepEqual(profilesOf(daemon), [undefined]);
  });
});

test("a daemon without protocolVersion is refused as too old", async () => {
  await withDaemon(async (daemon) => {
    daemon.protocolVersion = undefined;
    const client = new DaemonClient({ daemonUrl: daemon.url, authToken: daemon.token });

    await assert.rejects(client.connected(), (error: unknown) => {
      assert.ok(error instanceof DaemonUnavailableError, String(error));
      assert.match(error.message, /too old/);
      return true;
    });
  });
});

test("--profile wins over BRAVE_MCP_PROFILE", async () => {
  await withScript("profile-option-wins", async (scriptPath, daemon) => {
    daemon.profiles = ["Home", "Work"];

    const result = await runHarness(["--profile", "Work", scriptPath], {
      ...daemonEnv(daemon),
      BRAVE_MCP_PROFILE: "Home",
    });

    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.deepEqual(profilesOf(daemon), ["Work", "Work"]);
  });
});

test("BRAVE_MCP_PROFILE alone chooses the profile", async () => {
  await withScript("profile-env", async (scriptPath, daemon) => {
    daemon.profiles = ["Home", "Work"];

    const result = await runHarness([scriptPath], { ...daemonEnv(daemon), BRAVE_MCP_PROFILE: "Work" });

    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.deepEqual(profilesOf(daemon), ["Work", "Work"]);
  });
});

test("a chosen profile connected under another letter case runs", async () => {
  await withScript("profile-case", async (scriptPath, daemon) => {
    daemon.profiles = ["Home", "Work"];

    const result = await runHarness(["--profile", "work", scriptPath], daemonEnv(daemon));

    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(daemon.calls.length, 2);
  });
});

test("exit 3: the chosen profile is not connected, and no step runs", async () => {
  await withScript("profile-absent", async (scriptPath, daemon) => {
    daemon.profiles = ["Home"];

    const result = await runHarness(["--profile", "Work", scriptPath], daemonEnv(daemon));

    assert.equal(result.code, 3, result.stdout + result.stderr);
    assert.equal(daemon.calls.length, 0);
    assert.match(result.stderr, /Work/);
  });
});

test("without a chosen profile, one connected profile runs", async () => {
  await withScript("profile-single", async (scriptPath, daemon) => {
    daemon.profiles = ["Home"];

    const result = await runHarness([scriptPath], daemonEnv(daemon));

    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.deepEqual(profilesOf(daemon), [undefined, undefined]);
  });
});

test("exit 2: without a chosen profile and several connected, nothing runs and the nicknames are listed", async () => {
  await withScript("profile-several", async (scriptPath, daemon) => {
    daemon.profiles = ["Home", "Work"];

    const result = await runHarness([scriptPath], daemonEnv(daemon));

    assert.equal(result.code, 2, result.stdout + result.stderr);
    assert.equal(daemon.calls.length, 0);
    assert.match(result.stderr, /Home/);
    assert.match(result.stderr, /Work/);
    assert.doesNotMatch(result.stdout, /step 1\//);
  });
});

test("exit 3: a daemon without protocolVersion is reported as too old", async () => {
  await withScript("profile-old-daemon", async (scriptPath, daemon) => {
    daemon.protocolVersion = undefined;

    const result = await runHarness([scriptPath], daemonEnv(daemon));

    assert.equal(result.code, 3, result.stdout + result.stderr);
    assert.match(result.stderr, /too old/);
    assert.equal(daemon.calls.length, 0);
  });
});

test("exit 2: --profile without a value prints the usage line", async () => {
  await withScript("profile-no-value", async (scriptPath, daemon) => {
    const result = await runHarness([scriptPath, "--profile"], daemonEnv(daemon));

    assert.equal(result.code, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /^Usage: brave-mcp-play \[--profile <nickname>\] <script\.yaml>$/m);
    assert.equal(daemon.calls.length, 0);
  });
});

test("exit 3: the chosen profile disconnecting during the run is unavailable, not a step failure", async () => {
  const daemon = await FakeDaemon.start();
  const scriptPath = await writeScript("profile-drops", TWO_STEPS);
  try {
    daemon.profiles = ["Home", "Work"];
    daemon.reply("tabs.open", () => {
      daemon.profiles = ["Home"];
      return { error: { code: "BRAVE_PROFILE_NOT_FOUND", message: "The named profile is not connected." } };
    });

    const result = await runHarness(["--profile", "Work", scriptPath], daemonEnv(daemon));

    assert.equal(result.code, 3, result.stdout + result.stderr);
  } finally {
    await removeScript(scriptPath);
    await daemon.stop();
  }
});

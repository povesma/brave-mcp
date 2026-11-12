import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DaemonClient,
  DaemonError,
  DaemonUnavailableError,
  InvalidParamsError,
  daemonConfigDir,
  locateDaemon,
} from "../daemon-client.js";
import { FakeDaemon } from "./fake-daemon.js";

const fixtureConfigDir = fileURLToPath(new URL("../../fixtures/daemon-config", import.meta.url));

async function withDaemon(run: (daemon: FakeDaemon, client: DaemonClient) => Promise<void>): Promise<void> {
  const daemon = await FakeDaemon.start();
  try {
    await run(daemon, new DaemonClient({ daemonUrl: daemon.url, authToken: daemon.token }));
  } finally {
    await daemon.stop();
  }
}

test("the sent request carries every parameter, with the protocol defaults filled in", async () => {
  await withDaemon(async (daemon, client) => {
    daemon.reply("dom.type", { result: { typed: true } });

    const result = await client.call("dom.type", { tabId: 7, selector: "#user", text: "abc" });

    assert.deepEqual(result, { typed: true });
    assert.deepEqual(daemon.calls[0]?.params, {
      tabId: 7,
      selector: "#user",
      selectorType: "css",
      text: "abc",
      clearFirst: false,
      timeoutMs: 10_000,
    });
  });
});

test("invalid parameters are rejected before anything is sent", async () => {
  await withDaemon(async (daemon, client) => {
    await assert.rejects(client.call("dom.click", { tabId: 7, selector: "" }), InvalidParamsError);

    assert.equal(daemon.calls.length, 0);
  });
});

test("a request with no reply ends at the time limit with a timeout code", async () => {
  const daemon = await FakeDaemon.start();
  try {
    daemon.reply("tabs.list", { result: { tabs: [] }, delayMs: 5_000 });
    const client = new DaemonClient({ daemonUrl: daemon.url, authToken: daemon.token }, { timeLimitMs: 150 });

    const startedAt = Date.now();
    await assert.rejects(
      client.call("tabs.list", {}),
      (error) => error instanceof DaemonError && error.code === "BRAVE_TIMEOUT",
    );

    assert.ok(Date.now() - startedAt < 2_000);
  } finally {
    await daemon.stop();
  }
});

test("an error reply becomes a typed error that keeps the code", async () => {
  await withDaemon(async (daemon, client) => {
    daemon.reply("dom.click", { error: { code: "BRAVE_TAB_NOT_FOUND", message: "No tab with id 7." } });

    await assert.rejects(
      client.call("dom.click", { tabId: 7, selector: "#a" }),
      (error) =>
        error instanceof DaemonError && error.code === "BRAVE_TAB_NOT_FOUND" && error.message === "No tab with id 7.",
    );
  });
});

test("a result that lacks its expected fields becomes an internal error", async () => {
  await withDaemon(async (daemon, client) => {
    daemon.reply("tabs.open", { result: { tabId: null } });

    await assert.rejects(
      client.call("tabs.open", { url: "https://example.test/" }),
      (error) => error instanceof DaemonError && error.code === "BRAVE_INTERNAL_ERROR",
    );
  });
});

test("connected() is true only when the extension is connected and paired", async () => {
  await withDaemon(async (daemon, client) => {
    assert.equal(await client.connected(), true);

    daemon.extensionConnected = false;
    assert.equal(await client.connected(), false);

    daemon.extensionConnected = true;
    daemon.paired = false;
    assert.equal(await client.connected(), false);
  });
});

test("an unreachable daemon gives a distinct error", async () => {
  const daemon = await FakeDaemon.start();
  const client = new DaemonClient({ daemonUrl: daemon.url, authToken: daemon.token });
  await daemon.stop();

  await assert.rejects(client.call("tabs.list", {}), DaemonUnavailableError);
  await assert.rejects(client.connected(), DaemonUnavailableError);
});

test("the daemon location reads the three environment variables", async () => {
  const location = await locateDaemon({
    BRAVE_MCP_DAEMON_URL: "http://127.0.0.1:1234",
    BRAVE_MCP_CONFIG_DIR: "does-not-exist",
    BRAVE_MCP_AUTH_TOKEN: "override-token",
  });

  assert.deepEqual(location, { daemonUrl: "http://127.0.0.1:1234", authToken: "override-token" });
});

test("the daemon location defaults match the MCP server's and the token comes from the config file", async () => {
  const location = await locateDaemon({ BRAVE_MCP_CONFIG_DIR: fixtureConfigDir });

  assert.deepEqual(location, { daemonUrl: "http://127.0.0.1:39200", authToken: "fixture-daemon-token" });
  assert.equal(daemonConfigDir({}), join(homedir(), ".local", "share", "brave-mcp"));
});

test("a missing daemon config file is reported as daemon unavailable", async () => {
  await assert.rejects(locateDaemon({ BRAVE_MCP_CONFIG_DIR: "does-not-exist" }), DaemonUnavailableError);
});

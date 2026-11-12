import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeDaemon } from "./fake-daemon.js";

async function rpc(daemon: FakeDaemon, method: string, params: Record<string, unknown>, token = daemon.token) {
  const response = await fetch(`${daemon.url}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "req-1", method, params, authToken: token }),
    signal: AbortSignal.timeout(5_000),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("the fake daemon answers from its scripted queue and records each call", async () => {
  const daemon = await FakeDaemon.start();
  try {
    daemon.reply("dom.waitForSelector", { result: { found: false } }, { result: { found: true } });

    const first = await rpc(daemon, "dom.waitForSelector", { tabId: 7, selector: "#a" });
    const second = await rpc(daemon, "dom.waitForSelector", { tabId: 7, selector: "#a" });
    const third = await rpc(daemon, "dom.waitForSelector", { tabId: 7, selector: "#a" });

    assert.deepEqual(first.body.result, { found: false });
    assert.deepEqual(second.body.result, { found: true });
    assert.equal(third.body.ok, false);
    assert.deepEqual(
      daemon.calls.map((call) => call.method),
      ["dom.waitForSelector", "dom.waitForSelector", "dom.waitForSelector"],
    );
    assert.deepEqual(daemon.calls[0]?.params, { tabId: 7, selector: "#a" });
  } finally {
    await daemon.stop();
  }
});

test("the fake daemon rejects a wrong token without recording the call", async () => {
  const daemon = await FakeDaemon.start();
  try {
    daemon.reply("tabs.list", { result: { tabs: [] } });

    const reply = await rpc(daemon, "tabs.list", {}, "wrong-token");

    assert.equal(reply.status, 401);
    assert.equal((reply.body.error as { code: string }).code, "BRAVE_AUTH_REQUIRED");
    assert.equal(daemon.calls.length, 0);
  } finally {
    await daemon.stop();
  }
});

test("the fake daemon reports the readiness flags it was given", async () => {
  const daemon = await FakeDaemon.start();
  try {
    daemon.extensionConnected = false;

    const response = await fetch(`${daemon.url}/readyz`, { signal: AbortSignal.timeout(5_000) });
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(body.extensionConnected, false);
    assert.equal(body.paired, true);
  } finally {
    await daemon.stop();
  }
});

test("the fake daemon can delay a reply", async () => {
  const daemon = await FakeDaemon.start();
  try {
    daemon.reply("tabs.list", { result: { tabs: [] }, delayMs: 150 });

    const startedAt = Date.now();
    await rpc(daemon, "tabs.list", {});

    assert.ok(Date.now() - startedAt >= 140);
  } finally {
    await daemon.stop();
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { cmd, methodsOf, play, startTestServer } from "./engine-helpers.js";
import type { FakeDaemon, FakeReply } from "./fake-daemon.js";

const TAB = { result: { tabId: 41 } };

function scriptWith(...steps: string[]): string {
  return ["name: failing", "steps:", `  - open_tab: { url: "https://example.test/" }`, ...steps.map((step) => `  - ${step}`), ""].join(
    "\n",
  );
}

interface FailsWhenCase {
  rule: string;
  step: string;
  method: string;
  reply: FakeReply;
  code: string;
}

const FAILS_WHEN: FailsWhenCase[] = [
  {
    rule: "navigate: the status is a timeout",
    step: `navigate: { url: "https://example.test/next" }`,
    method: "tabs.navigate",
    reply: { result: { url: "https://example.test/next", status: "timeout" } },
    code: "NAVIGATION_TIMEOUT",
  },
  {
    rule: "type: typed is false",
    step: `type: { selector: "#a", text: "x" }`,
    method: "dom.type",
    reply: { result: { typed: false } },
    code: "NOT_TYPED",
  },
  {
    rule: "click: clicked is false",
    step: `click: { selector: "#a" }`,
    method: "dom.click",
    reply: { result: { clicked: false } },
    code: "NOT_CLICKED",
  },
  {
    rule: "press_key: pressed is false",
    step: `press_key: { key: Enter }`,
    method: "input.pressKey",
    reply: { result: { pressed: false } },
    code: "NOT_PRESSED",
  },
  {
    rule: "close_tab: closed is false",
    step: `close_tab: {}`,
    method: "tabs.close",
    reply: { result: { closed: false } },
    code: "NOT_CLOSED",
  },
  {
    rule: "any step: the daemon answers with an error",
    step: `click: { selector: "#a" }`,
    method: "dom.click",
    reply: { error: { code: "BRAVE_TAB_NOT_FOUND" } },
    code: "BRAVE_TAB_NOT_FOUND",
  },
];

for (const failsWhen of FAILS_WHEN) {
  test(`fails when — ${failsWhen.rule}`, async () => {
    const { outcome, lines, daemon } = await play(
      scriptWith(failsWhen.step, `run: { cmd: ${cmd("print-value", "never")} }`, `open_tab: { url: "https://example.test/never" }`),
      (fake) => {
        fake.reply("tabs.open", TAB);
        fake.reply(failsWhen.method, failsWhen.reply);
      },
    );

    assert.deepEqual(outcome, { status: "step_failed", step: 2, code: failsWhen.code });
    assert.ok(lines.some((line) => line.startsWith("step 2/4") && line.includes("failed")));
    assert.deepEqual(methodsOf(daemon), ["tabs.open", failsWhen.method]);
  });
}

test("fails when — open_tab returns no valid tab id", async () => {
  const { outcome, daemon } = await play(scriptWith(`click: { selector: "#a" }`), (fake) => {
    fake.reply("tabs.open", { result: { tabId: -1 } });
  });

  assert.deepEqual(outcome, { status: "step_failed", step: 1, code: "NO_TAB_ID" });
  assert.deepEqual(methodsOf(daemon), ["tabs.open"]);
});

test("fails when — a run command exits non-zero, without echoing its output", async () => {
  const { outcome, lines } = await play(scriptWith(`run: { cmd: ${cmd("exit-with", "3")} }`), (fake) => {
    fake.reply("tabs.open", TAB);
  });

  assert.deepEqual(outcome, { status: "step_failed", step: 2, code: "COMMAND_EXIT" });
  assert.ok(lines.some((line) => line.includes("exited with code 3")));
  assert.ok(!lines.join("\n").includes("stand-in"));
});

test("wait_for: a round ending in not found, an internal error or a daemon timeout is followed by another", async () => {
  const { outcome, daemon } = await play(
    scriptWith(`wait_for: { selector: "#late", timeout_s: 5 }`, `click: { selector: "#late" }`),
    (fake) => {
      fake.reply("tabs.open", TAB);
      fake.reply(
        "dom.waitForSelector",
        { result: { found: false } },
        { error: { code: "BRAVE_INTERNAL_ERROR" } },
        { error: { code: "BRAVE_TIMEOUT" } },
        { result: { found: true } },
      );
      fake.reply("dom.click", { result: { clicked: true } });
    },
  );

  assert.deepEqual(outcome, { status: "completed" });
  assert.equal(daemon.callsTo("dom.waitForSelector").length, 4);
  assert.equal(daemon.callsTo("dom.click").length, 1);
});

test("wait_for: the step fails only at its deadline", async () => {
  const startedAt = Date.now();
  const { outcome, daemon } = await play(scriptWith(`wait_for: { selector: "#never", timeout_s: 0.4 }`), (fake) => {
    fake.reply("tabs.open", TAB);
    fake.fallback("dom.waitForSelector", { result: { found: false } });
  });
  const elapsedMs = Date.now() - startedAt;

  assert.deepEqual(outcome, { status: "step_failed", step: 2, code: "NOT_FOUND" });
  assert.ok(elapsedMs >= 390, `failed after ${elapsedMs} ms, before the deadline`);
  assert.ok(daemon.callsTo("dom.waitForSelector").length >= 3);
  for (const call of daemon.callsTo("dom.waitForSelector")) {
    assert.ok((call.params.timeoutMs as number) <= 60, "each round is a short wait");
  }
});

function tabsReply(...urls: string[]): FakeReply {
  return {
    result: {
      tabs: urls.map((url, index) => ({ tabId: 70 + index, windowId: 1, title: "t", url, active: false })),
    },
  };
}

const USE_TAB = `use_tab: { url_prefix: "https://signin.example.test/", wait_s: 0.3, open: "https://signin.example.test/start" }`;
const CLICK = `click: { selector: "#confirm" }`;

function withoutOpenTab(...steps: string[]): string {
  return ["name: use-tab", "steps:", ...steps.map((step) => `  - ${step}`), ""].join("\n");
}

test("use_tab adopts the one tab whose URL starts with the prefix", async () => {
  const { outcome, daemon } = await play(withoutOpenTab(USE_TAB, CLICK), (fake) => {
    fake.reply("tabs.list", tabsReply("https://other.example.test/", "https://signin.example.test/authorize?x=1"));
    fake.reply("dom.click", { result: { clicked: true } });
  });

  assert.deepEqual(outcome, { status: "completed" });
  assert.deepEqual(methodsOf(daemon), ["tabs.list", "dom.click"]);
  assert.equal(daemon.callsTo("dom.click")[0]?.params.tabId, 71);
});

test("use_tab adopts a tab that appears while it waits", async () => {
  const { outcome, daemon } = await play(withoutOpenTab(USE_TAB, CLICK), (fake) => {
    fake.reply("tabs.list", tabsReply(), tabsReply("https://signin.example.test/authorize"));
    fake.reply("dom.click", { result: { clicked: true } });
  });

  assert.deepEqual(outcome, { status: "completed" });
  assert.equal(daemon.callsTo("tabs.open").length, 0);
  assert.equal(daemon.callsTo("dom.click")[0]?.params.tabId, 70);
});

test("use_tab opens the given URL when no tab matches within wait_s", async () => {
  const { outcome, daemon } = await play(withoutOpenTab(USE_TAB, CLICK), (fake) => {
    fake.fallback("tabs.list", tabsReply("https://other.example.test/"));
    fake.reply("tabs.open", { result: { tabId: 88 } });
    fake.reply("dom.click", { result: { clicked: true } });
  });

  assert.deepEqual(outcome, { status: "completed" });
  assert.equal(daemon.callsTo("tabs.open")[0]?.params.url, "https://signin.example.test/start");
  assert.equal(daemon.callsTo("dom.click")[0]?.params.tabId, 88);
});

test("use_tab fails when two tabs match the prefix", async () => {
  const { outcome, daemon } = await play(withoutOpenTab(USE_TAB, CLICK), (fake) => {
    fake.reply("tabs.list", tabsReply("https://signin.example.test/a", "https://signin.example.test/b"));
  });

  assert.deepEqual(outcome, { status: "step_failed", step: 1, code: "MANY_TABS" });
  assert.deepEqual(methodsOf(daemon), ["tabs.list"]);
});

test("a URL captured by start is used by later steps, and await succeeds after the callback", async () => {
  const { outcome, lines, daemon } = await play(
    withoutOpenTab(
      `start: { id: cli, cmd: ${cmd("url-then-wait", "--stream", "stderr")}, capture_match: { var: url, pattern: "http://127\\\\.0\\\\.0\\\\.1:\\\\d+/callback\\\\S*" }, timeout_s: 10 }`,
      `use_tab: { url_prefix: "http://127.0.0.1", wait_s: 0.1, open: "\${url}" }`,
      `run: { cmd: ${cmd("fetch-url", "${url}")} }`,
      `await: { id: cli, timeout_s: 10 }`,
      `close_tab: {}`,
    ),
    (fake) => {
      fake.fallback("tabs.list", tabsReply());
      fake.reply("tabs.open", { result: { tabId: 5 } });
      fake.reply("tabs.close", { result: { closed: true } });
    },
  );

  assert.deepEqual(outcome, { status: "completed" });
  const opened = String(daemon.callsTo("tabs.open")[0]?.params.url);
  assert.match(opened, /^http:\/\/127\.0\.0\.1:\d+\/callback\?state=one$/);
  assert.ok(!lines.join("\n").includes(opened), "the captured URL must not be printed");
  assert.equal(daemon.callsTo("tabs.close")[0]?.params.tabId, 5);
});

test("await fails when the background command exits non-zero", async () => {
  const { outcome } = await play(
    withoutOpenTab(
      `start: { id: cli, cmd: ${cmd("url-then-wait", "--exit-code", "4")}, capture_match: { var: url, pattern: "http://127\\\\.0\\\\.0\\\\.1:\\\\d+/callback\\\\S*" }, timeout_s: 10 }`,
      `run: { cmd: ${cmd("fetch-url", "${url}")} }`,
      `await: { id: cli, timeout_s: 10 }`,
    ),
    () => undefined,
  );

  assert.deepEqual(outcome, { status: "step_failed", step: 3, code: "COMMAND_EXIT" });
});

function clickSelectors(daemon: FakeDaemon): unknown[] {
  return daemon.callsTo("dom.click").map((call) => call.params.selector);
}

test("on_failure: alternative selectors are tried in order after the main one, and a success continues", async () => {
  const { outcome, daemon } = await play(
    scriptWith(`click: { selector: "#main", on_failure: { selectors: ["#alt1", "#alt2"] } }`, `press_key: { key: Enter }`),
    (fake) => {
      fake.reply("tabs.open", TAB);
      fake.reply(
        "dom.click",
        { result: { clicked: false } },
        { error: { code: "BRAVE_INTERNAL_ERROR" } },
        { result: { clicked: true } },
      );
      fake.reply("input.pressKey", { result: { pressed: true } });
    },
  );

  assert.deepEqual(outcome, { status: "completed" });
  assert.deepEqual(clickSelectors(daemon), ["#main", "#alt1", "#alt2"]);
  assert.equal(daemon.callsTo("input.pressKey").length, 1);
});

test("on_failure: retry repeats the whole round the stated number of times with the stated wait", async () => {
  const startedAt = Date.now();
  const { outcome, daemon } = await play(
    scriptWith(
      `click: { selector: "#main", on_failure: { selectors: ["#alt"], retry: { times: 2, wait_s: 0.15 } } }`,
      `press_key: { key: Enter }`,
    ),
    (fake) => {
      fake.reply("tabs.open", TAB);
      fake.fallback("dom.click", { result: { clicked: false } });
    },
  );
  const elapsedMs = Date.now() - startedAt;

  assert.deepEqual(outcome, { status: "step_failed", step: 2, code: "NOT_CLICKED" });
  assert.deepEqual(clickSelectors(daemon), ["#main", "#alt", "#main", "#alt", "#main", "#alt"]);
  assert.ok(elapsedMs >= 290, `two waits of 150 ms expected, took ${elapsedMs} ms`);
  assert.equal(daemon.callsTo("input.pressKey").length, 0);
});

test("on_failure: a later round can succeed", async () => {
  const { outcome, daemon } = await play(
    scriptWith(`click: { selector: "#main", on_failure: { retry: { times: 3, wait_s: 0.02 } } }`),
    (fake) => {
      fake.reply("tabs.open", TAB);
      fake.reply("dom.click", { result: { clicked: false } }, { result: { clicked: true } });
    },
  );

  assert.deepEqual(outcome, { status: "completed" });
  assert.equal(daemon.callsTo("dom.click").length, 2);
});

test("on_failure: a run step with retry is run again", async () => {
  const server = await startTestServer((hit) => (hit === 1 ? { status: 500, body: "" } : { body: "fresh-value" }));
  try {
    const { outcome, daemon } = await play(
      scriptWith(
        `run: { cmd: ${cmd("fetch-url", server.url)}, capture: value, on_failure: { retry: { times: 1, wait_s: 0.02 } } }`,
        `type: { selector: "#a", text: "\${value}" }`,
      ),
      (fake) => {
        fake.reply("tabs.open", TAB);
        fake.reply("dom.type", { result: { typed: true } });
      },
    );

    assert.deepEqual(outcome, { status: "completed" });
    assert.equal(server.hits.length, 2);
    assert.equal(daemon.callsTo("dom.type")[0]?.params.text, "fresh-value");
  } finally {
    await server.stop();
  }
});

test("on_failure: with then stop, the run ends once every round has failed", async () => {
  const { outcome, daemon } = await play(
    scriptWith(`click: { selector: "#main", on_failure: { retry: { times: 1, wait_s: 0.02 }, then: stop } }`),
    (fake) => {
      fake.reply("tabs.open", TAB);
      fake.fallback("dom.click", { result: { clicked: false } });
    },
  );

  assert.deepEqual(outcome, { status: "step_failed", step: 2, code: "NOT_CLICKED" });
  assert.equal(daemon.callsTo("dom.click").length, 2);
});

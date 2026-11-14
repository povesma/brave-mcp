import assert from "node:assert/strict";
import { test } from "node:test";

import { methodsOf, play } from "./engine-helpers.js";

const TAB = { result: { tabId: 41 } };

function scriptWith(...steps: string[]): string {
  return ["name: skip-if-found", "steps:", `  - open_tab: { url: "https://example.test/" }`, ...steps.map((step) => `  - ${step}`), ""].join(
    "\n",
  );
}

test("skip_if_found: selector present jumps straight to the labelled step, skipping every step between", async () => {
  const { outcome, daemon } = await play(
    scriptWith(
      `skip_if_found: { selector: "#signed-in", to: after }`,
      `click: { selector: "#signin" }`,
      `type: { selector: "#password", text: "secret" }`,
      `click: { selector: "#continue", label: after }`,
    ),
    (fake) => {
      fake.reply("tabs.open", TAB);
      fake.reply("dom.waitForSelector", { result: { found: true } });
      fake.reply("dom.click", { result: { clicked: true } });
    },
  );

  assert.deepEqual(outcome, { status: "completed" });
  assert.deepEqual(methodsOf(daemon), ["tabs.open", "dom.waitForSelector", "dom.click"]);
  assert.equal(daemon.callsTo("dom.click")[0]?.params.selector, "#continue");
});

test("skip_if_found: selector absent continues at the very next step, as if it were absent", async () => {
  const { outcome, daemon } = await play(
    scriptWith(
      `skip_if_found: { selector: "#signed-in", to: after }`,
      `click: { selector: "#signin" }`,
      `click: { selector: "#continue", label: after }`,
    ),
    (fake) => {
      fake.reply("tabs.open", TAB);
      fake.reply("dom.waitForSelector", { result: { found: false } });
      fake.reply("dom.click", { result: { clicked: true } }, { result: { clicked: true } });
    },
  );

  assert.deepEqual(outcome, { status: "completed" });
  assert.deepEqual(methodsOf(daemon), ["tabs.open", "dom.waitForSelector", "dom.click", "dom.click"]);
  assert.deepEqual(
    daemon.callsTo("dom.click").map((call) => call.params.selector),
    ["#signin", "#continue"],
  );
});

test("skip_if_found: a step strictly between the probe and the label never runs, so its capture never happens", async () => {
  const { outcome, daemon } = await play(
    scriptWith(
      `skip_if_found: { selector: "#signed-in", to: after }`,
      `run: { cmd: ["node", "-e", "console.log(1)"], capture: user }`,
      `click: { selector: "#continue", label: after }`,
    ),
    (fake) => {
      fake.reply("tabs.open", TAB);
      fake.reply("dom.waitForSelector", { result: { found: true } });
      fake.reply("dom.click", { result: { clicked: true } });
    },
  );

  assert.deepEqual(outcome, { status: "completed" });
  // The run step must not have executed: only tabs.open, the probe and the click happened.
  assert.deepEqual(methodsOf(daemon), ["tabs.open", "dom.waitForSelector", "dom.click"]);
});

test("skip_if_found: does one short probe, not the wait_for retry loop", async () => {
  const { outcome, daemon } = await play(
    scriptWith(`skip_if_found: { selector: "#signed-in", to: after, timeout_s: 0.2 }`, `click: { selector: "#a", label: after }`),
    (fake) => {
      fake.reply("tabs.open", TAB);
      fake.fallback("dom.waitForSelector", { result: { found: false } });
      fake.reply("dom.click", { result: { clicked: true } });
    },
  );

  assert.deepEqual(outcome, { status: "completed" });
  assert.equal(daemon.callsTo("dom.waitForSelector").length, 1, "skip_if_found must not retry like wait_for");
});

test("skip_if_found: the probe uses the default timeout_s of 3 when not stated", async () => {
  const { outcome, daemon } = await play(
    scriptWith(`skip_if_found: { selector: "#signed-in", to: after }`, `click: { selector: "#a", label: after }`),
    (fake) => {
      fake.reply("tabs.open", TAB);
      fake.reply("dom.waitForSelector", { result: { found: false } });
      fake.reply("dom.click", { result: { clicked: true } });
    },
  );

  assert.deepEqual(outcome, { status: "completed" });
  assert.equal(daemon.callsTo("dom.waitForSelector")[0]?.params.timeoutMs, 3_000);
});

test("skip_if_found: an error other than not-found fails the step like any other", async () => {
  const { outcome, daemon } = await play(
    scriptWith(`skip_if_found: { selector: "#signed-in", to: after }`, `click: { selector: "#a", label: after }`),
    (fake) => {
      fake.reply("tabs.open", TAB);
      fake.reply("dom.waitForSelector", { error: { code: "BRAVE_TAB_NOT_FOUND" } });
    },
  );

  assert.deepEqual(outcome, { status: "step_failed", step: 2, code: "BRAVE_TAB_NOT_FOUND" });
  assert.deepEqual(methodsOf(daemon), ["tabs.open", "dom.waitForSelector"]);
});

test("skip_if_found: the selector is sent as written, never substituted", async () => {
  const { outcome, daemon } = await play(
    scriptWith(
      `run: { cmd: ["node", "-e", "process.stdout.write('v')"], capture: user }`,
      `skip_if_found: { selector: "#a-\${user}", to: after }`,
      `click: { selector: "#a", label: after }`,
    ),
    (fake) => {
      fake.reply("tabs.open", TAB);
      fake.reply("dom.waitForSelector", { result: { found: true } });
      fake.reply("dom.click", { result: { clicked: true } });
    },
  );

  assert.deepEqual(outcome, { status: "completed" });
  assert.equal(daemon.callsTo("dom.waitForSelector")[0]?.params.selector, "#a-${user}");
});

test("jump: continues at its label without a daemon call, and the steps between never run", async () => {
  const { outcome, daemon } = await play(
    scriptWith(
      `skip_if_found: { selector: "#tile", to: pick }`,
      `click: { selector: "#signin" }`,
      `jump: { to: done }`,
      `click: { selector: "#tile", label: pick }`,
      `click: { selector: "#continue", label: done }`,
    ),
    (fake) => {
      fake.reply("tabs.open", TAB);
      fake.reply("dom.waitForSelector", { result: { found: false } });
      fake.reply("dom.click", { result: { clicked: true } }, { result: { clicked: true } });
    },
  );

  assert.deepEqual(outcome, { status: "completed" });
  assert.deepEqual(
    daemon.callsTo("dom.click").map((call) => call.params.selector),
    ["#signin", "#continue"],
  );
});

test("skip_if_found: has no on_failure of its own, so a retry/pause setting cannot be attached in the first place", async () => {
  const { outcome } = await play(
    scriptWith(`skip_if_found: { selector: "#signed-in", to: after }`, `click: { selector: "#a", label: after }`),
    (fake) => {
      fake.reply("tabs.open", TAB);
      fake.reply("dom.waitForSelector", { error: { code: "BRAVE_INTERNAL_ERROR" } });
    },
  );

  // A single attempt; no retry round happens since skip_if_found has no on_failure.
  assert.deepEqual(outcome, { status: "step_failed", step: 2, code: "BRAVE_INTERNAL_ERROR" });
});

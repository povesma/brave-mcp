import assert from "node:assert/strict";
import { test } from "node:test";

import { cmd, methodsOf, play } from "./engine-helpers.js";

const LOGIN_SCRIPT = `
name: login
steps:
  - open_tab: { url: "https://signin.example.test/" }
  - run: { cmd: ${cmd("print-value", "alice-user")}, capture: user }
  - run: { cmd: ${cmd("print-value", "s3cret pass&word")}, capture: pass }
  - type: { selector: "#username", text: "\${user}" }
  - type: { selector: "#password", text: "\${pass}" }
  - click: { selector: "#signin" }
  - wait_for: { selector: "#mfa", timeout_s: 5 }
  - run: { cmd: ${cmd("print-value", "654321")}, capture: otp }
  - type: { selector: "#mfa", text: "\${otp}" }
  - click: { selector: "#submit" }
  - wait_for: { selector: "#signed-in", timeout_s: 5 }
`;

test("a login-shaped script is played in order on its own tab without printing a captured value", async () => {
  const { outcome, lines, daemon } = await play(LOGIN_SCRIPT, (fake) => {
    fake.reply("tabs.open", { result: { tabId: 41 } });
    fake.reply("dom.type", { result: { typed: true } }, { result: { typed: true } }, { result: { typed: true } });
    fake.reply("dom.click", { result: { clicked: true } }, { result: { clicked: true } });
    fake.reply("dom.waitForSelector", { result: { found: true } }, { result: { found: true } });
  });

  assert.deepEqual(outcome, { status: "completed" });
  assert.deepEqual(methodsOf(daemon), [
    "tabs.open",
    "dom.type",
    "dom.type",
    "dom.click",
    "dom.waitForSelector",
    "dom.type",
    "dom.click",
    "dom.waitForSelector",
  ]);

  assert.equal(daemon.calls[0]?.params.url, "https://signin.example.test/");
  for (const call of daemon.calls.slice(1)) {
    assert.equal(call.params.tabId, 41, `${call.method} must carry the tab id returned by open_tab`);
  }

  const typed = daemon.callsTo("dom.type").map((call) => [call.params.selector, call.params.text, call.params.clearFirst]);
  assert.deepEqual(typed, [
    ["#username", "alice-user", true],
    ["#password", "s3cret pass&word", true],
    ["#mfa", "654321", true],
  ]);

  const output = lines.join("\n");
  for (const secret of ["alice-user", "s3cret pass&word", "s3cret", "654321", encodeURIComponent("s3cret pass&word")]) {
    assert.ok(!output.includes(secret), `harness output must not contain a captured value`);
  }
  assert.equal(lines.filter((line) => line.endsWith(": started")).length, 11);
});

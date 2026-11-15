import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { formatProblem, loadScript, parseScript, type ScriptProblem } from "../script.js";

const ALL_STEP_TYPES = `
name: all-steps
pause_timeout_s: 120
precondition:
  cmd: [check-credentials]
steps:
  - open_tab: { url: "https://example.test/login" }
  - navigate: { url: "https://example.test/form" }
  - run: { cmd: [get-user], capture: user }
  - wait_for:
      selector: "#username"
      timeout_s: 20
      on_failure:
        selectors: ["input[name=user]"]
        retry: { times: 2, wait_s: 3 }
        then: pause
  - type: { selector: "#username", text: "\${user}" }
  - click: { selector: "#signin" }
  - press_key: { key: Enter }
  - start:
      id: cli
      cmd: [cli-login, "--name", "\${user}"]
      env: { BROWSER: "true" }
      capture_match: { var: url, pattern: "https://example\\\\.test/authorize\\\\S+" }
      timeout_s: 20
  - use_tab: { url_prefix: "https://example.test/", wait_s: 3, open: "\${url}" }
  - reload: {}
  - skip_if_found: { selector: "#signed-in", to: done }
  - jump: { to: done }
  - await: { id: cli, timeout_s: 60, label: done }
  - close_tab: {}
`;

function problemsOf(steps: string): ScriptProblem[] {
  const result = parseScript(`name: faulty\nsteps:\n${steps}`);
  assert.equal(result.ok, false);
  return result.ok ? [] : result.problems;
}

function assertProblem(problems: ScriptProblem[], step: number, reason: RegExp): void {
  const found = problems.some((problem) => problem.step === step && reason.test(problem.reason));
  assert.ok(found, `expected step ${step} to match ${reason}, got: ${problems.map(formatProblem).join(" | ")}`);
}

test("a script using all fourteen step types is accepted", () => {
  const result = parseScript(ALL_STEP_TYPES);

  assert.ok(result.ok, result.ok ? "" : result.problems.map(formatProblem).join(" | "));
  assert.equal(result.script.name, "all-steps");
  assert.equal(result.script.pause_timeout_s, 120);
  assert.deepEqual(result.script.precondition?.cmd, ["check-credentials"]);
  assert.deepEqual(
    result.script.steps.map((step) => step.kind),
    [
      "open_tab",
      "navigate",
      "run",
      "wait_for",
      "type",
      "click",
      "press_key",
      "start",
      "use_tab",
      "reload",
      "skip_if_found",
      "jump",
      "await",
      "close_tab",
    ],
  );

  const waitFor = result.script.steps[3];
  assert.ok(waitFor?.kind === "wait_for");
  assert.equal(waitFor.state, "visible");
  assert.equal(waitFor.timeout_s, 20);
  assert.deepEqual(waitFor.on_failure, {
    selectors: ["input[name=user]"],
    retry: { times: 2, wait_s: 3 },
    then: "pause",
  });
});

test("an unknown step type is rejected with its step number", () => {
  const problems = problemsOf(`  - open_tab: { url: "https://example.test" }\n  - hover: { selector: "#a" }\n`);

  assertProblem(problems, 2, /unknown step type "hover"/);
});

test("risky step type names are rejected as not available", () => {
  for (const name of ["execute_javascript", "cookie_access", "session_export"]) {
    const problems = problemsOf(`  - open_tab: { url: "https://example.test" }\n  - ${name}: {}\n`);

    assertProblem(problems, 2, /is not available/);
  }
});

test("a missing required field is rejected and named", () => {
  const problems = problemsOf(`  - open_tab: { url: "https://example.test" }\n  - click: {}\n`);

  assertProblem(problems, 2, /missing required field "selector"/);
});

test("a misspelled field is rejected and named", () => {
  const problems = problemsOf(`  - open_tab: { url: "https://example.test" }\n  - click: { selecter: "#a" }\n`);

  assertProblem(problems, 2, /unknown field "selecter"/);
});

test("a variable that is never captured is rejected", () => {
  const problems = problemsOf(
    `  - open_tab: { url: "https://example.test" }\n  - type: { selector: "#a", text: "\${nope}" }\n`,
  );

  assertProblem(problems, 2, /variable "nope" is never captured/);
});

test("a variable used before the step that captures it is rejected", () => {
  const problems = problemsOf(
    [
      `  - open_tab: { url: "https://example.test" }`,
      `  - type: { selector: "#a", text: "\${user}" }`,
      `  - run: { cmd: [get-user], capture: user }`,
      ``,
    ].join("\n"),
  );

  assertProblem(problems, 2, /variable "user" is used before step 3 captures it/);
});

test("a variable inside the precondition is rejected", () => {
  const result = parseScript(
    `name: faulty\nprecondition:\n  cmd: [check, "\${user}"]\nsteps:\n  - run: { cmd: [get-user], capture: user }\n`,
  );

  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.problems.some((problem) => /precondition/.test(problem.reason)));
});

test("a browser step before any open_tab or use_tab is rejected", () => {
  const problems = problemsOf(`  - click: { selector: "#a" }\n  - open_tab: { url: "https://example.test" }\n`);

  assertProblem(problems, 1, /open_tab or use_tab/);
});

test("a browser step after close_tab needs a new target tab", () => {
  const problems = problemsOf(
    `  - open_tab: { url: "https://example.test" }\n  - close_tab: {}\n  - click: { selector: "#a" }\n`,
  );

  assertProblem(problems, 3, /open_tab or use_tab/);
});

test("a duplicate start id is rejected", () => {
  const problems = problemsOf(`  - start: { id: cli, cmd: [one] }\n  - start: { id: cli, cmd: [two] }\n`);

  assertProblem(problems, 2, /start id "cli" is already used/);
});

test("await of an unknown id is rejected", () => {
  const problems = problemsOf(`  - start: { id: cli, cmd: [one] }\n  - await: { id: other }\n`);

  assertProblem(problems, 2, /unknown id "other"/);
});

test("alternative selectors are rejected on a step that has no selector", () => {
  const problems = problemsOf(`  - run: { cmd: [one], on_failure: { selectors: ["#a"] } }\n`);

  assertProblem(problems, 1, /unknown field "on_failure\.selectors"/);
});

test("every problem in a script is reported, not only the first", () => {
  const problems = problemsOf(`  - click: { selector: "#a" }\n  - await: { id: other }\n`);

  assertProblem(problems, 1, /open_tab or use_tab/);
  assertProblem(problems, 2, /unknown id "other"/);
});

test("a YAML syntax error is rejected with its line number", () => {
  const result = parseScript(`name: faulty\nsteps:\n  - click: { selector: "#a"\n  - close_tab: {}\n`);

  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.problems.length > 0);
  assert.ok(!result.ok && result.problems.every((problem) => typeof problem.line === "number"));
  assert.ok(!result.ok && /^line \d+: /.test(formatProblem(result.problems[0]!)));
});

for (const shipped of ["fixtures/login.yaml", "fixtures/reload-tab.yaml"]) {
  test(`the shipped script ${shipped} is valid`, async () => {
    const result = await loadScript(fileURLToPath(new URL(`../../${shipped}`, import.meta.url)));

    assert.ok(result.ok, result.ok ? "" : result.problems.map(formatProblem).join(" | "));
  });
}

test("a script file that cannot be read is rejected", async () => {
  const result = await loadScript("fixtures/does-not-exist.yaml");

  assert.equal(result.ok, false);
  assert.ok(!result.ok && /cannot read script file/.test(result.problems[0]?.reason ?? ""));
});

test("use_tab with url_regex, pick and activate, and reload with defaults, are accepted", () => {
  const result = parseScript(
    [
      "name: regex-tab",
      "steps:",
      `  - use_tab: { url_regex: "^https://[a-z0-9-]+\\\\.console\\\\.example\\\\.test/", pick: first, activate: true }`,
      "  - reload: {}",
      "",
    ].join("\n"),
  );

  assert.ok(result.ok, result.ok ? "" : result.problems.map(formatProblem).join(" | "));
  const [useTab, reload] = result.script.steps;
  assert.ok(useTab?.kind === "use_tab");
  assert.equal(useTab.pick, "first");
  assert.equal(useTab.activate, true);
  assert.equal(useTab.open, undefined);
  assert.ok(reload?.kind === "reload");
  assert.equal(reload.wait_until, "domcontentloaded");
  assert.equal(reload.timeout_s, 30);
});

test("use_tab needs exactly one of url_prefix and url_regex", () => {
  assertProblem(
    problemsOf(`  - use_tab: { url_prefix: "https://a.test/", url_regex: "a", open: "https://a.test/" }\n`),
    1,
    /exactly one of "url_prefix" and "url_regex"/,
  );
  assertProblem(problemsOf(`  - use_tab: { open: "https://a.test/" }\n`), 1, /exactly one of "url_prefix" and "url_regex"/);
});

test("use_tab with an invalid url_regex is rejected", () => {
  assertProblem(problemsOf(`  - use_tab: { url_regex: "(" }\n`), 1, /not a valid regular expression/);
});

test("reload before any open_tab or use_tab is rejected", () => {
  assertProblem(problemsOf(`  - reload: {}\n  - open_tab: { url: "https://example.test" }\n`), 1, /open_tab or use_tab/);
});

test("skip_if_found with a label later in the script is accepted", () => {
  const result = parseScript(
    [
      "name: skip",
      "steps:",
      `  - open_tab: { url: "https://example.test/" }`,
      `  - skip_if_found: { selector: "#signed-in", to: already-in }`,
      `  - click: { selector: "#signin" }`,
      `  - click: { selector: "#continue", label: already-in }`,
      "",
    ].join("\n"),
  );

  assert.ok(result.ok, result.ok ? "" : result.problems.map(formatProblem).join(" | "));
  const skip = result.script.steps[1];
  assert.ok(skip?.kind === "skip_if_found");
  assert.equal(skip.selector, "#signed-in");
  assert.equal(skip.to, "already-in");
  assert.equal(skip.timeout_s, 3);
  const target = result.script.steps[3];
  assert.equal(target?.label, "already-in");
});

test("skip_if_found accepts an explicit timeout_s", () => {
  const result = parseScript(
    [
      "name: skip",
      "steps:",
      `  - open_tab: { url: "https://example.test/" }`,
      `  - skip_if_found: { selector: "#signed-in", to: done, timeout_s: 1.5 }`,
      `  - click: { selector: "#signin", label: done }`,
      "",
    ].join("\n"),
  );

  assert.ok(result.ok, result.ok ? "" : result.problems.map(formatProblem).join(" | "));
  const skip = result.script.steps[1];
  assert.ok(skip?.kind === "skip_if_found");
  assert.equal(skip.timeout_s, 1.5);
});

test("skip_if_found does not accept on_failure", () => {
  assertProblem(
    problemsOf(
      `  - open_tab: { url: "https://example.test" }\n  - skip_if_found: { selector: "#a", to: x, on_failure: { then: pause } }\n  - click: { selector: "#a", label: x }\n`,
    ),
    2,
    /unknown field "on_failure"/,
  );
});

test("skip_if_found with an unknown label is rejected", () => {
  assertProblem(
    problemsOf(`  - open_tab: { url: "https://example.test" }\n  - skip_if_found: { selector: "#a", to: nope }\n`),
    2,
    /label "nope"/,
  );
});

test("skip_if_found pointing at a backward label is rejected", () => {
  assertProblem(
    problemsOf(
      `  - open_tab: { url: "https://example.test", label: top }\n  - skip_if_found: { selector: "#a", to: top }\n`,
    ),
    2,
    /label "top".*(earlier|backward|later)/,
  );
});

test("skip_if_found pointing at its own step's label is rejected", () => {
  assertProblem(
    problemsOf(`  - open_tab: { url: "https://example.test" }\n  - skip_if_found: { selector: "#a", to: here, label: here }\n`),
    2,
    /label "here".*(itself|later|same)/,
  );
});

test("a duplicate label is rejected", () => {
  assertProblem(
    problemsOf(
      [
        `  - open_tab: { url: "https://example.test", label: dup }`,
        `  - click: { selector: "#a", label: dup }`,
        ``,
      ].join("\n"),
    ),
    2,
    /label "dup" is already used/,
  );
});

test("a variable captured only by a step a jump can skip, and used at or after the label, is rejected", () => {
  const problems = problemsOf(
    [
      `  - open_tab: { url: "https://example.test" }`,
      `  - skip_if_found: { selector: "#signed-in", to: after }`,
      `  - run: { cmd: [get-user], capture: user }`,
      `  - type: { selector: "#username", text: "\${user}", label: after }`,
      ``,
    ].join("\n"),
  );

  assertProblem(problems, 4, /variable "user" is not captured on every path/);
});

test("a tab closed and reopened inside a skipped range is accepted, since both paths reach the label with a tab", () => {
  const result = parseScript(
    [
      "name: reopen",
      "steps:",
      `  - open_tab: { url: "https://example.test/one" }`,
      `  - skip_if_found: { selector: "#signed-in", to: after }`,
      `  - close_tab: {}`,
      `  - open_tab: { url: "https://example.test/two" }`,
      `  - click: { selector: "#a", label: after }`,
      "",
    ].join("\n"),
  );

  assert.ok(result.ok, result.ok ? "" : result.problems.map(formatProblem).join(" | "));
});

test("a target tab closed on one path and needed at the label is rejected", () => {
  const problems = problemsOf(
    [
      `  - open_tab: { url: "https://example.test/one" }`,
      `  - skip_if_found: { selector: "#signed-in", to: after }`,
      `  - jump: { to: closing }`,
      `  - close_tab: { label: closing }`,
      `  - click: { selector: "#a", label: after }`,
      ``,
    ].join("\n"),
  );

  assertProblem(problems, 5, /needs a target tab on every path/);
});

test("a variable that two jumps together can leave uncaptured is rejected", () => {
  const problems = problemsOf(
    [
      `  - open_tab: { url: "https://example.test" }`,
      `  - skip_if_found: { selector: "#one", to: a }`,
      `  - run: { cmd: [get-user], capture: user }`,
      `  - click: { selector: "#x", label: a }`,
      `  - skip_if_found: { selector: "#two", to: b }`,
      `  - run: { cmd: [get-user], capture: user }`,
      `  - type: { selector: "#u", text: "\${user}", label: b }`,
      ``,
    ].join("\n"),
  );

  assertProblem(problems, 7, /variable "user" is not captured on every path/);
});

test("an await whose start a jump can skip is rejected", () => {
  const problems = problemsOf(
    [
      `  - open_tab: { url: "https://example.test" }`,
      `  - skip_if_found: { selector: "#in", to: after }`,
      `  - start: { id: cli, cmd: [one] }`,
      `  - await: { id: cli, label: after }`,
      ``,
    ].join("\n"),
  );

  assertProblem(problems, 4, /await of "cli": its start step is not played on every path/);
});

test("jump to a later label is accepted and needs no target tab", () => {
  const result = parseScript(
    ["name: jump", "steps:", `  - run: { cmd: [one] }`, `  - jump: { to: end }`, `  - run: { cmd: [two], label: end }`, ""].join("\n"),
  );

  assert.ok(result.ok, result.ok ? "" : result.problems.map(formatProblem).join(" | "));
});

test("a step after a jump that no label reaches is rejected as one that can never run", () => {
  const result = parseScript(
    [
      "name: jump",
      "steps:",
      `  - run: { cmd: [one] }`,
      `  - jump: { to: end }`,
      `  - run: { cmd: [two], label: middle }`,
      `  - run: { cmd: [three], label: end }`,
      "",
    ].join("\n"),
  );

  assert.equal(result.ok, false, "step 3 is reachable by no path, so the script is rejected");
  assertProblem(result.ok ? [] : result.problems, 3, /can never run/);
});

test("jump branches: each step after a jump is reached by some label", () => {
  const result = parseScript(
    [
      "name: branches",
      "steps:",
      `  - open_tab: { url: "https://example.test" }`,
      `  - skip_if_found: { selector: "#tile", to: pick }`,
      `  - click: { selector: "#signin" }`,
      `  - jump: { to: done }`,
      `  - click: { selector: "#tile", label: pick }`,
      `  - close_tab: { label: done }`,
      "",
    ].join("\n"),
  );

  assert.ok(result.ok, result.ok ? "" : result.problems.map(formatProblem).join(" | "));
  const jump = result.script.steps[3];
  assert.ok(jump?.kind === "jump");
  assert.equal(jump.to, "done");
});

test("jump with an unknown or backward label is rejected", () => {
  assertProblem(problemsOf(`  - run: { cmd: [one] }\n  - jump: { to: nope }\n`), 2, /label "nope"/);
  assertProblem(problemsOf(`  - run: { cmd: [one], label: top }\n  - jump: { to: top }\n`), 2, /label "top".*later/);
});

test("jump accepts no other field", () => {
  assertProblem(problemsOf(`  - run: { cmd: [one] }\n  - jump: { to: x, on_failure: { then: pause } }\n  - run: { cmd: [two], label: x }\n`), 2, /unknown field "on_failure"/);
});

test("a jump-skippable variable capture is fine when used only before the skip_if_found", () => {
  const result = parseScript(
    [
      "name: skip-ok",
      "steps:",
      `  - open_tab: { url: "https://example.test/" }`,
      `  - run: { cmd: [get-user], capture: user }`,
      `  - type: { selector: "#username", text: "\${user}" }`,
      `  - skip_if_found: { selector: "#signed-in", to: after }`,
      `  - click: { selector: "#signin" }`,
      `  - click: { selector: "#continue", label: after }`,
      "",
    ].join("\n"),
  );

  assert.ok(result.ok, result.ok ? "" : result.problems.map(formatProblem).join(" | "));
});

test("a variable captured by the label step itself, then used right after it, is fine", () => {
  const result = parseScript(
    [
      "name: skip-ok",
      "steps:",
      `  - open_tab: { url: "https://example.test/" }`,
      `  - skip_if_found: { selector: "#signed-in", to: after }`,
      `  - click: { selector: "#signin" }`,
      `  - run: { cmd: [get-user], capture: user, label: after }`,
      `  - type: { selector: "#username", text: "\${user}" }`,
      "",
    ].join("\n"),
  );

  assert.ok(result.ok, result.ok ? "" : result.problems.map(formatProblem).join(" | "));
});

test("a variable captured before a skip_if_found is fine to use after its label, since every path sets it", () => {
  const result = parseScript(
    [
      "name: skip-ok",
      "steps:",
      `  - open_tab: { url: "https://example.test/" }`,
      `  - run: { cmd: [get-user], capture: user }`,
      `  - skip_if_found: { selector: "#signed-in", to: after }`,
      `  - click: { selector: "#signin" }`,
      `  - type: { selector: "#username", text: "\${user}", label: after }`,
      "",
    ].join("\n"),
  );

  assert.ok(result.ok, result.ok ? "" : result.problems.map(formatProblem).join(" | "));
});

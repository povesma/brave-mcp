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
  - await: { id: cli, timeout_s: 60 }
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

test("a script using all eleven step types is accepted", () => {
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

for (const shipped of ["fixtures/login.yaml", "scripts/aws-login.template.yaml"]) {
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

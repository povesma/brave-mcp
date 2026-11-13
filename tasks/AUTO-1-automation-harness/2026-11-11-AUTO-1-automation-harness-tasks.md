# automation-harness - Task List

## Relevant Files
- [2026-11-11-AUTO-1-automation-harness-tech-design.md](2026-11-11-AUTO-1-automation-harness-tech-design.md)
  :: Browser Automation Harness - Technical Design
- [2026-11-11-AUTO-1-automation-harness-prd.md](2026-11-11-AUTO-1-automation-harness-prd.md)
  :: Browser Automation Harness - Product Requirements Document
- [apps/harness/package.json](../../apps/harness/package.json) :: New
  workspace package definition, build and verify scripts.
- [apps/harness/tsconfig.json](../../apps/harness/tsconfig.json) :: TypeScript
  settings, copied from `apps/daemon/tsconfig.json`.
- [apps/harness/src/index.ts](../../apps/harness/src/index.ts) :: Command
  entry, exit codes.
- [apps/harness/src/script.ts](../../apps/harness/src/script.ts) :: YAML
  loading and validation.
- [apps/harness/src/daemon-client.ts](../../apps/harness/src/daemon-client.ts)
  :: Daemon location and RPC client.
- [apps/harness/src/commands.ts](../../apps/harness/src/commands.ts) ::
  Command runner (to completion and background).
- [apps/harness/src/mask.ts](../../apps/harness/src/mask.ts) :: Secret mask.
- [apps/harness/src/engine.ts](../../apps/harness/src/engine.ts) :: Step loop,
  failure handling, pause and resume.
- [apps/harness/src/test/fake-daemon.ts](../../apps/harness/src/test/fake-daemon.ts)
  :: Scripted stand-in daemon for tests.
- [apps/harness/src/test/](../../apps/harness/src/test/) :: One
  `*.test.ts` file per component.
- [apps/harness/fixtures/](../../apps/harness/fixtures/) :: Fixture site,
  stand-in commands and fixture script (plain JavaScript and YAML), and a
  sample daemon config file used by the client test.
- [apps/harness/src/test/engine-helpers.ts](../../apps/harness/src/test/engine-helpers.ts),
  [entry-helpers.ts](../../apps/harness/src/test/entry-helpers.ts) :: Shared
  test helpers (play a script against the fake daemon; start the compiled
  command; write temporary scripts to the git-ignored `apps/harness/tmp/`).
- [apps/harness/scripts/aws-login.template.yaml](../../apps/harness/scripts/aws-login.template.yaml)
  :: AWS login script with placeholders.
- [apps/harness/README.md](../../apps/harness/README.md) :: Usage, step
  reference, profile setup guide.
- [package.json](../../package.json) :: Root scripts `build:harness`,
  `verify:harness` (lines 14-25).
- [.gitignore](../../.gitignore) :: Ignore `apps/harness/local/`.
- [README.md](../../README.md) :: Repository layout and verification
  sections.

## Notes
- Tests use Node's built-in test runner over compiled files in
  `apps/harness/dist/test`; run them with `npm run verify:harness`.
- Test files live in `apps/harness/src/test/`, named after the component they
  cover (for example `script.test.ts`).
- Stand-in commands used by tests are plain JavaScript files in
  `apps/harness/fixtures/commands/`, started with `node`.
- The tech-design marks three code facts as reported by the reviewer and not
  re-checked; sub-tasks 3.2 and 5.3 re-check them before relying on them.
- All design terms used below (step types, "fails when" rules, exit codes)
  are defined in the tech-design.

## State At Hand-Off
- Stories 1 to 6 are done. Story 7 is coded and tested except the operator
  check 7.5 (which also closes 7.2). In stories 8 and 9 every sub-task that
  needs no operator is done (8.1 to 8.3, 9.1 to 9.3), and 9.4 is done: the
  extension runs in the operator's existing dedicated profile. `npm run
  verify:harness` passes 99 tests with no browser.
- Story 7 is done: the operator's terminal run paused on a wrong selector
  and completed after the fix and Enter.
- Story 8 is done: the fixture run passed in real Brave, and neither the
  daemon log nor the extension storage holds the stand-in secrets.
- Open: 9.5 and 9.6 (real AWS run, by the operator).
- The harness package, the root file changes and the three AUTO-1 documents
  are committed locally on the feature branch by operator choice; the branch
  is not pushed.
- Operator decision: the real-browser fixture run (8.4, 8.5) waits until the
  automation profile exists (9.4), so nothing runs in the everyday profile.
- In this Claude Code session, a request from one shell call could not reach
  a server started by another shell call in the background (`curl: (7)
  Failed to connect to 127.0.0.1 port 39310`), while the daemon's port
  answered. Not investigated. If 8.4 is run by Claude, the fixture site may
  have to be started by the operator in a terminal.
- Work happens on branch `feat/AUTO-1-automation-harness`, created from
  `main` by operator choice.
- Local setup the tasks rely on: dependencies installed and all packages
  built; daemon config directory is `~/.local/share/brave-mcp`; the MCP
  server is registered in Claude Code as `brave-mcp`.
- The extension is currently loaded and paired in the operator's everyday
  Brave profile, not a dedicated one. Sub-task 8.4 would therefore open tabs
  in the everyday profile unless 9.4 is done first; ask the operator.
- The daemon is not set up as a background service; it runs only while
  something has started it.
- The task list has not had an independent critique; the operator declined
  the prompt that offered it.

## Open Items Outside This Feature
- MCP tool-schema fix (`apps/mcp/src/tools.ts`, tool input schemas are now
  emitted inline so MCP clients accept the tool list): committed as
  `b7f4278` on `fix/mcp-tool-schema-inline` and pushed. The pull request is
  not opened: `gh pr create` failed with "must be a collaborator".
- The extension's access to every tab of its profile has no guardrail in the
  daemon; the dedicated-profile setup (story 9) is the chosen mitigation.

## TDD Planning Guidelines
Follow TDD where feasible:
- **Test external interfaces only** — exported functions and the command's
  observable behaviour. Never test internal implementation details.
- **Test behavior, not mechanism.** Cover each module as a cohesive unit.
- **Alternate in small chunks:** write test → implement → write test →
  implement, one small piece of functionality at a time.
- **Apply TDD** to the loader, client, command runner, mask and engine.
  **Skip it** for package scaffolding, fixtures, templates and documents.

## Tasks
- [X] 1.0 **User Story:** As a developer, I want an `apps/harness` workspace
  package that builds and has a passing verify command so that every later
  task has a place to add code and tests [4/0]
  - [X] 1.1 Create `apps/harness/package.json` (`@brave-mcp/harness`, version
    0.11.0, ES module, `bin` `brave-mcp-play` → `dist/index.js`; dependencies
    `@brave-mcp/protocol` as a file link, `yaml` ^2.8, `zod` ^3.24; the same
    dev dependencies as `apps/daemon`; `build` builds the protocol package
    then runs `tsc`; `verify` runs `build` then
    `node --test "dist/test/**/*.test.js"` — a file pattern, because current
    Node versions read a bare directory argument as a module file) and
    `apps/harness/tsconfig.json` copied from `apps/daemon/tsconfig.json`
    [verify: code-only]
  - [X] 1.2 Add `build:harness` and `verify:harness` to the root
    `package.json` scripts, following the existing entries
    [verify: code-only]
  - [X] 1.3 Add `src/index.ts` that prints a usage line and exits with code 2
    when no script path is given, and `src/test/entry.test.ts` that starts
    the compiled entry with no arguments and checks the exit code
    [verify: auto-test]
    → 1 passed, 0 failed; with a script path the entry exits 1 with a
      "not implemented yet" line until 5.8 [live] (2026-11-11)
  - [X] 1.4 Run `npm install` and `npm run verify:harness`; the build
    succeeds and the test passes [verify: manual-run-claude]
    → install added the `yaml` package; build and test pass; the compiled
      entry run by hand prints the usage line and exits 2 [live] (2026-11-11)
- [X] 2.0 **User Story:** As an operator, I want a YAML script loaded and
  fully validated before anything runs so that a faulty script is rejected
  with the step number and reason instead of half-playing a login [2/0]
  - [X] 2.1 Write tests for the loader's exported function. Accepted: one
    script using all eleven step types, `precondition`, `pause_timeout_s`
    and `on_failure`. Rejected, each with step number and reason: unknown
    step type; a risky step type name (run page code, cookies, session
    export); missing required field; variable used but never captured;
    variable used before the step that captures it; browser step before any
    `open_tab` or `use_tab`; duplicate `start` id; `await` of an unknown id;
    YAML syntax error (with line number) [verify: auto-test]
    → 16 loader tests written, covering every listed case [live] (2026-11-11)
  - [X] 2.2 Implement `src/script.ts` with zod schemas for the script format
    in the tech-design ("Data Models") to pass the tests
    [verify: auto-test]
    → 17 passed, 0 failed; step fields and defaults chosen here are recorded
      in the tech-design "Step fields" table [live] (2026-11-11)
- [X] 3.0 **User Story:** As a developer, I want a daemon client that sends
  complete parameters, enforces time limits and keeps the error code so that
  the engine can judge every browser step reliably [3/0]
  - [X] 3.1 Implement `src/test/fake-daemon.ts`: an HTTP server on a free
    port with `GET /readyz` (settable `extensionConnected` and `paired`) and
    `POST /rpc` that checks the token, answers each method from a scripted
    queue of replies, can delay a reply, and records every call received;
    cover it with a test that scripts two replies and reads the call log
    [verify: auto-test]
    → 4 passed, 0 failed [live] (2026-11-11)
  - [X] 3.2 Re-check in the code that the daemon does not validate
    parameters (`packages/protocol/src/rpc.ts:57`) and find the exported
    per-method input schemas in `packages/protocol/src/tools.ts`. Then write
    tests for the client: parameters are parsed with the method's input
    schema so defaults are present in the sent request; invalid parameters
    are rejected before sending; a request with no reply ends at the time
    limit; an error reply becomes a typed error that keeps the code;
    `connected()` reads `extensionConnected` and `paired`; an unreachable
    daemon gives a distinct error; daemon location reads the three
    environment variables with the defaults in `apps/mcp/src/config.ts` and
    the token from the daemon config file [verify: auto-test]
    → re-check confirmed: the request schema accepts any parameter object,
      and the protocol has no method-to-schema table, so the client carries
      its own for nine methods; 10 client tests written [live] (2026-11-11)
  - [X] 3.3 Implement `src/daemon-client.ts` to pass the tests; it never
    starts a daemon [verify: auto-test]
    → 10 passed, 0 failed; results are also parsed with the protocol's
      output schema, so a missing field is an internal error
      [live] (2026-11-11)
- [X] 4.0 **User Story:** As an operator, I want commands run without a shell
  — to completion or in the background — with their output captured into
  masked variables so that credentials and one-time codes reach the browser
  and never the logs [6/0]
  - [X] 4.1 Write tests for the mask: a registered value is replaced in
    output; its URL-encoded form is replaced; several values are replaced in
    one line; an empty value is not registered [verify: auto-test]
    → 5 mask tests written [live] (2026-11-11)
  - [X] 4.2 Implement `src/mask.ts` to pass the tests [verify: auto-test]
    → 5 passed, 0 failed; the form-encoded variant (space as `+`) is masked
      too [live] (2026-11-11)
  - [X] 4.3 Add stand-in commands in `apps/harness/fixtures/commands/`
    (print a given value; print its arguments one per line; exit with a
    given code; sleep) and write tests for run-to-completion: an argument
    containing `;`, spaces and `$(...)` arrives as one unchanged argument;
    standard output is returned with the trailing line break removed; a
    non-zero exit is a failure reporting the exit code only; the time limit
    ends the command; an empty capture is a failure; the child environment
    lacks the harness token variable and contains the step's `env` values
    [verify: auto-test]
    → 7 tests written; a fifth stand-in (`print-env.mjs`) was added for the
      environment test [live] (2026-11-11)
  - [X] 4.4 Implement run-to-completion in `src/commands.ts` to pass the
    tests [verify: auto-test]
    → 7 passed, 0 failed [live] (2026-11-11)
  - [X] 4.5 Add a stand-in command that prints a URL on a chosen stream then
    waits for a local HTTP request before exiting, and write tests for
    background commands: the pattern is captured from standard output and
    from standard error; a second distinct match is a failure; exit before
    a match is a failure; no match within the time limit is a failure;
    `await` returns the exit code and fails on non-zero or on its time
    limit; a command printing a large amount of output does not block;
    ending the runner ends its background commands [verify: auto-test]
    → 9 tests written around `url-then-wait.mjs` [live] (2026-11-11)
  - [X] 4.6 Implement background start and await in `src/commands.ts` to
    pass the tests [verify: auto-test]
    → 9 passed, 0 failed; a match is judged 250 ms after it first appears,
      so a second distinct match inside that window fails the step
      [live] (2026-11-11)
- [X] 5.0 **User Story:** As an operator, I want the harness to play a script
  from first step to last on its own tab, passing captured values forward and
  exiting with a documented code so that a login runs as one command [8/0]
  - [X] 5.1 Write an engine test that plays a login-shaped script (open tab,
    two captured values, type, type, click, wait, captured code, type,
    click, wait) against the fake daemon: the call log matches the script in
    order; every browser call carries the tab id returned by `open_tab`; the
    `type` calls carry the captured values and the clear-first flag; no
    captured value appears anywhere in the harness output
    [verify: auto-test]
    → login-shaped engine test written [live] (2026-11-11)
  - [X] 5.2 Implement the step loop in `src/engine.ts` (target tab, variable
    table, `${name}` substitution, reporter that passes every line through
    the mask) for `open_tab`, `navigate`, `type`, `click`, `press_key`,
    `close_tab` and `run` to pass the test [verify: auto-test]
    → 1 passed, 0 failed; output shows step number, step type and a failure
      code only, never a daemon message [live] (2026-11-11)
  - [X] 5.3 Re-check the result fields in `packages/protocol/src/tools.ts`
    for the eight browser methods, then write one test per "Fails when" rule
    in the tech-design step table (invalid tab id, navigation timeout
    status, `typed`/`clicked`/`pressed`/`closed` false, daemon error): each
    ends the run with exit code 1 and names the step number. Add tests for
    `wait_for`: rounds ending in "not found", an internal error or a daemon
    timeout are followed by another round; success in a later round
    continues; the step fails only at its deadline [verify: auto-test]
    → re-check confirmed the result fields (`status`, `typed`, `clicked`,
      `pressed`, `closed`, `found`, `tabId`); 10 tests written
      [live] (2026-11-11)
  - [X] 5.4 Implement the failure rules and the repeated short waits of
    `wait_for` to pass the tests [verify: auto-test]
    → 10 passed, 0 failed; a "tab not found" reply ends `wait_for` at once
      instead of waiting for the deadline [live] (2026-11-11)
  - [X] 5.5 Write tests for `use_tab` (one tab matching the prefix is
    adopted; none within `wait_s` opens the `open` URL; two matches fail)
    and for `start`/`await` inside a script (captured URL is used by a later
    step; `await` after the stand-in command's callback succeeds)
    [verify: auto-test]
    → 6 tests written; stand-ins `fetch-url.mjs` and
      `announce-then-sleep.mjs` added [live] (2026-11-11)
  - [X] 5.6 Implement `use_tab`, `start` and `await` in the engine, and end
    background commands on normal exit, `SIGINT` and `SIGTERM`, to pass the
    tests [verify: auto-test]
    → 9 passed, 0 failed; a signal also ends the command running in the
      foreground, and the harness exits 130 (`SIGINT`) or 143 (`SIGTERM`)
      [live] (2026-11-11)
  - [X] 5.7 Write tests that start the compiled command: script completed →
    0; invalid script → 2 with zero daemon calls; daemon unreachable → 3;
    extension not connected at start → 3; "auth required" reply → 3;
    "extension offline" reply while `/readyz` shows not connected → 3;
    "extension offline" reply while connected → step failure, 1;
    precondition command exits 0 → 10 with zero daemon calls; precondition
    exits non-zero → steps run [verify: auto-test]
    → 11 tests written, each starting the compiled command
      [live] (2026-11-11)
  - [X] 5.8 Implement the entry in `src/index.ts` (load, locate daemon,
    readiness check, precondition, run engine, exit code) to pass the tests
    [verify: auto-test]
    → 11 passed, 0 failed; the precondition runs before the daemon is
      contacted, so "already satisfied" exits 10 even when Brave is closed
      [live] (2026-11-11)
- [X] 6.0 **User Story:** As an operator, I want each step to retry and try
  alternative selectors before giving up so that a slow or slightly changed
  page does not break the run [2/0]
  - [X] 6.1 Write tests for `on_failure`: alternative selectors are tried in
    order after the main one and a success continues the script; `retry`
    repeats the whole round the stated number of times with the stated wait;
    a `run` step with `retry` is run again; when every round fails and
    `then` is absent or `stop`, the run exits 1 [verify: auto-test]
    → 5 tests written [live] (2026-11-11)
  - [X] 6.2 Implement `selectors` and `retry` in the engine to pass the
    tests [verify: auto-test]
    → 5 passed, 0 failed [live] (2026-11-11)
- [X] 7.0 **User Story:** As an operator, I want a stuck step to pause the
  running process and resume after I fix the script, with fresh one-time
  values and nothing written to disk, so that I do not restart the whole
  login [5/0]
  - [X] 7.1 Write tests for pause: a failed step with `then: pause` keeps
    the process running and prints the step number, step type, error code,
    the tab address without its query part, the tab title and the
    background commands still running; no page content and no captured
    value is printed; `SIGUSR2` resumes; after the stuck step's selector is
    corrected in the script file, the resumed run completes with exit 0
    [verify: auto-test]
    → 1 test written; it starts the compiled command and sends the signal
      [live] (2026-11-11)
  - [X] 7.2 Implement pause, script reload and resume on `SIGUSR2` or on a
    line from standard input when a terminal is attached
    [verify: auto-test]
    → pause, reload and `SIGUSR2` resume: 1 passed, 0 failed
      [live] (2026-11-11); resume by pressing Enter needs a terminal and is
      not covered by a test — it is checked by 7.5
    → resume by Enter confirmed by the operator run in 7.5 [live] (2026-11-13)
  - [X] 7.3 Write tests for the resume rules: a reloaded script whose
    already-played steps differ is refused and the pause continues; an
    invalid reloaded script is refused and the pause continues; every
    earlier `run` step whose variable the stuck step uses is run again
    before the retry (the stand-in command returns a new value each time and
    the new value reaches the fake daemon); a stuck step using a `start`
    capture whose command has exited makes the resume fail with that
    reason; the pause time limit ends the run with exit 1; the working
    directory and the system temp directory hold no new files after a
    paused and resumed run [verify: auto-test]
    → 5 tests written [live] (2026-11-11)
  - [X] 7.4 Implement the resume rules and the pause time limit to pass the
    tests [verify: auto-test]
    → 5 passed, 0 failed; a resume that needs a value from an exited
      background command ends the run with exit 1; a `run` step that fails
      when run again refuses the resume and the pause continues
      [live] (2026-11-11)
  - [X] 7.5 Operator check in a terminal: run the fixture script with a
    wrong selector, see the pause report, correct the selector, press Enter,
    and see the run complete [verify: manual-run-user]
    → operator run: paused at step 8 with NOT_FOUND after both rounds; after
      the fix and Enter it resumed at step 8 and completed all 19 steps;
      `completed` is printed only on the exit-0 path [live] (2026-11-13)
- [X] 8.0 **User Story:** As a developer, I want a login-shaped fixture site,
  stand-in commands and a fixture script played against real Brave so that
  the harness is proven in a real browser without AWS [5/0]
  - [X] 8.1 Add `apps/harness/fixtures/site-server.mjs`: a local site with a
    username and password form, a one-time-code field that appears after a
    delay, and a success marker shown only for the expected values; it
    prints one progress line per request and stops after a time limit
    [verify: code-only]
    → also covered by 2 tests in `fixtures.test.ts` that start the site and
      request its pages: 2 passed [live] (2026-11-11)
  - [X] 8.2 Add `apps/harness/fixtures/commands/fake-cli-login.mjs`: prints
    a sign-in URL on standard error, serves a page with a confirm button
    that calls its local callback, and exits 0 when the callback is hit
    [verify: code-only]
    → also covered by 1 test in `fixtures.test.ts`: 1 passed
      [live] (2026-11-11)
  - [X] 8.3 Add `apps/harness/fixtures/login.yaml`: the full login-shaped
    flow against the fixture site, including `start`, `use_tab`, `await` and
    `close_tab` [verify: code-only]
    → the loader accepts it (test "the shipped script ... is valid"); the
      sign-in tab is closed before `use_tab` so the prefix matches one tab
      only [live] (2026-11-11)
  - [X] 8.4 With the operator's agreement, start the fixture site and play
    `login.yaml` against the paired Brave; the run reaches the success
    marker and exits 0 [verify: manual-run-claude]
    → 19 of 19 steps ok in the operator's dedicated profile, exit 0
      [live] (2026-11-13)
  - [X] 8.5 After that run, search the daemon's log output and the
    extension's stored status for the stand-in password and code; neither
    is present [verify: manual-run-claude]
    → extension storage of every profile holds neither value; a control
      search finds the stored daemon address there [live] (2026-11-13)
    → a replay through the daemon with logging on: 25 requests logged, no
      line holds the stand-in user, password or code; the everyday daemon
      runs `--silent`, so it logs nothing [live] (2026-11-13)
- [ ] 9.0 **User Story:** As an operator, I want a dedicated-profile setup
  guide, an AWS login script template and a git-ignored place for my real
  script so that I can run the AWS login unattended in an isolated profile
  [6/0]
  - [X] 9.1 Write `apps/harness/README.md`: command usage, the eleven step
    types with their fields, `on_failure`, variables, exit codes, pause and
    resume, the fixtures and how to run them, and the limitations listed in
    the tech-design; add the package to the repository layout and
    verification sections of the root `README.md` [verify: code-only]
  - [X] 9.2 Add the profile setup guide to `apps/harness/README.md`: create
    an automation profile in Brave, load the extension only there, pair it
    with the daemon, remove the extension from the everyday profile
    [verify: code-only]
  - [X] 9.3 Add `apps/harness/scripts/aws-login.template.yaml` with
    placeholders for the sign-in address, selectors, the credential and
    one-time-code commands, the `aws login` step with the
    browser-suppressing variable, and a credential-check precondition; add
    `apps/harness/local/` to `.gitignore` [verify: code-only]
    → the credential-check command is a placeholder; the loader accepts the
      template [live] (2026-11-11)
  - [X] 9.4 Operator: set up the automation profile by the guide; the
    daemon readiness check shows the extension connected and paired, and a
    tab list shows only the automation profile's tabs
    [verify: manual-run-user]
    → operator's existing dedicated profile used; readiness shows connected
      and paired, and the one window seen matches that profile by operator
      check [live] (2026-11-13)
  - [ ] 9.5 Operator: copy the template to `apps/harness/local/`, fill it
    in, and run it. Record: exit code; whether a tab opened in the everyday
    profile; whether the sign-in URL was captured within the time limit;
    whether typed values were accepted by the sign-in form
    [verify: manual-run-user]
  - [ ] 9.6 Record the outcomes of 9.5 against the two open assumptions in
    the tech-design, and list any follow-up work they require
    [verify: code-only]

# AUTO-1: Browser Automation Harness - Technical Design

**Status**: Draft (revised after independent critique)
**PRD**: [2026-11-11-AUTO-1-automation-harness-prd.md](2026-11-11-AUTO-1-automation-harness-prd.md)
**Created**: 2026-11-11

## Overview

A new runnable package, `apps/harness`, plays a YAML script. It is one more
client of the existing daemon: browser steps become daemon RPC calls, shell
steps become child processes started without a shell. The daemon, the
extension and the protocol are not changed.

One process plays one script from the first step to the last, holds captured
values in memory, and exits with a code that states the outcome.

## Current Architecture (verified)

- **Daemon RPC.** `POST /rpc` with `{id, method, params, authToken}`; the reply
  is `{ok: true, result}` or `{ok: false, error: {code, message, retryable}}`
  — verified via: `packages/protocol/src/rpc.ts:54-97` (export list),
  `specs/rpc/daemon-rpc.schema.json:85-171`, 2026-11-11.
- **Parameters are not validated on the way in.** The request schema accepts
  any parameter object, and the extension converts values without checking
  them, so a missing field becomes a meaningless value instead of an error —
  [reported by the independent critique at `packages/protocol/src/rpc.ts:57`
  and `apps/extension/src/background.ts:3632-3641`; re-check when implementing
  the client].
- **Error codes the extension really returns.** A thrown error becomes "tab
  not found", "permission denied" or "internal error", always marked not
  retryable. "Selector not found" is never returned. An unimplemented method
  returns the "extension offline" code — verified via:
  `apps/extension/src/background.ts:4231-4260`, 2026-11-11.
- **Readiness.** `GET /readyz` always reports `ready: true`; only
  `extensionConnected` and `paired` change — verified via:
  `apps/daemon/src/app.ts:188-197`, 2026-11-11.
- **One profile per daemon.** A new extension connection closes the previous
  one — verified via: `apps/daemon/src/app.ts:140-143`, 2026-11-11.
- **Daemon time limit.** The daemon waits `max(5 s, params.timeoutMs + 0.5 s)`
  for the extension, then answers with a timeout error — verified via:
  `apps/daemon/src/app.ts:99-116`, 2026-11-11.
- **Wait-for-selector.** On timeout the extension returns `found: false`; it
  does not raise an error. The wait runs as a script injected into the page —
  verified via: `apps/extension/src/background.ts:1380-1441`, 2026-11-11.
  A page navigation during the wait may end it with `found: false` or with an
  internal error [assumption — the design absorbs both, see "wait_for"].
- **Open tab.** Takes a URL and an "active" flag; returns the new tab id —
  verified via: `packages/protocol/src/tools.ts:86-93`, 2026-11-11. The id can
  be an invalid value when the browser returns none [reported by the critique
  at `apps/extension/src/background.ts:395`].
- **Type.** Appends to the field unless told to clear it first; navigation
  reports a timeout as a normal result with a status field — [reported by the
  critique at `packages/protocol/src/tools.ts:136-139,196-200`; re-check when
  implementing each step].
- **List tabs.** Returns every tab of the connected profile with its URL —
  verified via: `packages/protocol/src/tools.ts:23-29` and a live `list_tabs`
  call, 2026-11-11.
- **Existing daemon client.** No time limit, request id from the clock, and a
  failure is thrown as a plain `Error` with the code inside the message text
  — verified via: `apps/mcp/src/daemon-client.ts:1-29`, 2026-11-11.
- **How the MCP server locates the daemon.** Three environment variables
  (daemon URL, config directory, token override) with defaults, and it may
  start a daemon when none answers — [reported by the critique at
  `apps/mcp/src/config.ts:34-44`].
- **Simulated extension.** `packages/sdk` exports a simulated extension that
  answers each method from built-in logic with a small tab list — verified
  via: `packages/sdk/src/index.ts:54-124`, 2026-11-11. A test cannot script
  its replies, so it cannot play "selector absent, then present".
- **Test convention.** Each package has a `verify` script that builds its
  dependencies, then itself, and runs `dist/verify.js` — verified via:
  `apps/daemon/package.json:11-14`, 2026-11-11.
- **`aws login`.** Prints the sign-in URL, keeps running until the browser
  flow reaches its local callback, then exits — verified via:
  `aws login help`, AWS CLI 2.36.16, 2026-11-11.

The PRD assumption about the wait-for-selector timeout is resolved. The PRD
assumption that `aws login` behaves like a short command was false; the PRD is
amended.

## Past Decisions (Claude-Mem)

None. Project memory holds no earlier designs.

## Proposed Design

### Architecture

```
            script.yaml
                 |
           +-----v------+
           |   loader   |  parse + validate, nothing runs on error
           +-----+------+
                 |
           +-----v------+        +----------------+
           |   engine   +------->|  command runner |--> child processes
           | step loop  |        +----------------+     (no shell)
           | target tab |
           | variables  |        +----------------+
           | failure +  +------->|  daemon client  |--> POST /rpc
           |   pause    |        +----------------+
           +-----+------+
                 |
           +-----v------+
           |  reporter  |  every line passes the secret mask
           +------------+
```

### Components

**New — all in `apps/harness/src/`**

- **Loader (`script.ts`)** — reads the file, parses YAML, validates the whole
  script with zod schemas, and checks that every variable a step uses is
  captured by an earlier step. Returns a typed step list or a list of
  problems (step number + reason).
- **Daemon client (`daemon-client.ts`)** — one `call(method, params)` function.
  Before sending, it parses the parameters with the protocol's own input
  schema for that method, so every field is present and defaults are applied.
  Random request ids, a time limit on every request, and a typed error that
  keeps the code. Also `connected()` over `GET /readyz`, which reads
  `extensionConnected` and `paired` only.
- **Command runner (`commands.ts`)** — starts child processes with a program
  and an argument list, never through a shell. Two modes: run to completion
  and capture standard output; start in the background, watch both output
  streams for a pattern, and report the exit later. Both streams are always
  read to the end so a command never blocks on a full pipe. A command inherits
  the harness environment without the harness's token variable, plus the
  step's own `env`.
- **Secret mask (`mask.ts`)** — a registry of captured values. Each value is
  registered as captured and in URL-encoded form. The reporter replaces every
  registered form in all output with a fixed mask.
- **Engine (`engine.ts`)** — the step loop. Owns the target tab, the variable
  table, the background commands, per-step failure handling and pause.
- **Entry (`index.ts`)** — argument parsing, daemon location, exit codes.
- **Fake daemon (`test/fake-daemon.ts`)** — a small HTTP server answering
  `/readyz` and `/rpc` from a scripted list of replies; records the calls it
  received.

**Modified**

- `package.json` (root) — add `build:harness` and `verify:harness` scripts.
  Risk: none.
- `README.md` — list the new package and its verify command. Risk: none.

### Data Models

**Script file**

```yaml
name: example-login
pause_timeout_s: 600          # optional

precondition:                 # optional; exit 0 means "already satisfied"
  cmd: [check-credentials]

steps:
  - open_tab: { url: "https://signin.example.com" }
  - run: { cmd: [get-user], capture: user }
  - run: { cmd: [get-pass], capture: pass }
  - type: { selector: "#username", text: "${user}" }
  - type: { selector: "#password", text: "${pass}" }
  - click: { selector: "#signin" }
  - wait_for:
      selector: "#mfa"
      timeout_s: 30
      on_failure:
        selectors: ["input[name=mfaCode]"]
        retry: { times: 2, wait_s: 3 }
        then: pause
  - run: { cmd: [get-otp], capture: otp }
  - type: { selector: "#mfa", text: "${otp}" }
  - click: { selector: "#submit" }
  - wait_for: { selector: "#signed-in-marker", timeout_s: 30 }
  - start:
      id: cli
      cmd: [cli-login]
      env: { BROWSER: "true" }
      capture_match:
        var: url
        pattern: "https://signin\\.example\\.com/authorize\\S+"
      timeout_s: 20
  - use_tab:
      url_prefix: "https://signin.example.com/"
      wait_s: 3
      open: "${url}"
  - click: { selector: "#confirm" }
  - await: { id: cli, timeout_s: 60 }
  - close_tab: {}
```

**Step types (complete list for v1)**

| Step | Meaning | Daemon method | Fails when |
|---|---|---|---|
| `open_tab` | Open a URL in a new tab; it becomes the target | `tabs.open` | error, or no valid tab id returned |
| `use_tab` | Make the tab whose URL starts with `url_prefix` the target; if none appears within `wait_s`, open `open` in a new tab | `tabs.list`, `tabs.open` | error, or more than one tab matches |
| `navigate` | Load a URL in the target tab | `tabs.navigate` | error, or status is a timeout |
| `wait_for` | Wait until a selector is present or visible | `dom.waitForSelector` | not found at the step's deadline |
| `type` | Clear the field, then type text | `dom.type` | error, or `typed` is false |
| `click` | Click an element | `dom.click` | error, or `clicked` is false |
| `press_key` | Press a key | `input.pressKey` | error, or `pressed` is false |
| `close_tab` | Close the target tab | `tabs.close` | error, or `closed` is false |
| `run` | Run a command to completion; optionally capture its output | — | non-zero exit, time limit, or empty capture |
| `start` | Start a command in the background; optionally capture the first output text matching a pattern | — | no match within the time limit, more than one distinct match, or the command exits first |
| `await` | Wait for a background command to exit | — | non-zero exit or time limit |

A script with any other step type is rejected by the loader. Steps that run
page code, read cookies or export session data do not exist in v1.

**Step fields** (a field not listed is rejected; every step also accepts
`on_failure`)

| Step | Required | Optional (default) |
|---|---|---|
| `open_tab` | `url` | — |
| `use_tab` | `url_prefix`, `open` | `wait_s` (3) |
| `navigate` | `url` | `timeout_s` (30) |
| `wait_for` | `selector` | `state`: `visible` or `attached` (`visible`), `timeout_s` (30) |
| `type` | `selector`, `text` | — |
| `click` | `selector` | — |
| `press_key` | `key` | `modifiers` (none) |
| `close_tab` | — | — |
| `run` | `cmd` | `capture`, `env`, `timeout_s` (60) |
| `start` | `id`, `cmd` | `env`, `capture_match` (`var`, `pattern`), `timeout_s` (30) |
| `await` | `id` | `timeout_s` (120) |

Top level: `name` (required), `pause_timeout_s` (600), `precondition`
(`cmd`, optional `env`, `timeout_s` 60), `steps` (at least one). A variable
cannot be used in the precondition. After `close_tab`, a browser step needs a
new `open_tab` or `use_tab`.

**Variables**

- Created by `capture` (whole standard output, trailing line break removed)
  or `capture_match` (the text matching the pattern, on either output stream).
- Used as `${name}` inside `url`, `open`, `text`, command arguments and `env`
  values.
- Every captured value is registered with the secret mask at once.

**Per-step failure setting (`on_failure`)**

- `selectors` — alternative selectors for this step, tried in order after the
  main one.
- `retry` — how many more rounds to try (`times`), and the wait between
  rounds (`wait_s`, default 1). One round tries the main selector, then each
  alternative. `selectors` is accepted only on `wait_for`, `type` and `click`.
- `then` — what to do when every round has failed: `stop` (default) or
  `pause`.

**Exit codes**

| Code | Meaning |
|---|---|
| 0 | Script completed |
| 1 | A step failed (including a pause that timed out) |
| 2 | Script invalid |
| 3 | Daemon or extension unavailable |
| 10 | Precondition passed: already satisfied, no step ran |

### API Design

Command line only: `brave-mcp-play <script.yaml>`. No network interface. The
daemon is located through the same three environment variables and defaults
the MCP server uses. Unlike the MCP server, the harness never starts a daemon.

### Integration Points

- Daemon `GET /readyz` — before the first step, and whenever a call reports
  "extension offline".
- Daemon `POST /rpc` — every browser step.
- `@brave-mcp/protocol` — method names, per-method input schemas, response
  schema, error codes.
- Child processes — every `run`, `start` and `precondition`.

### Behaviour details a developer needs

- **Target tab.** The engine holds one tab id. `open_tab` and `use_tab` set
  it; every other browser step sends it. A browser step before any target is
  set is rejected by the loader.
- **Step outcome comes from the result, not the error code.** The extension
  never reports "selector not found" and never marks an error retryable, so
  the engine judges each step by the "Fails when" column above. Any daemon
  error on a step is a step failure, with two exceptions below.
- **Unavailable.** "Auth required" ends the run with exit code 3. "Extension
  offline" makes the engine ask `/readyz`: if the extension is not connected
  and paired, exit code 3; otherwise the call is a step failure.
- **`wait_for`.** The engine repeats short waits until its own deadline. A
  round that ends with "not found", an internal error or a daemon timeout is
  followed by the next round. Only the deadline makes the step fail.
- **Pause.** The engine prints the step number, step type, the error code,
  and the address of the target tab without its query part, plus the title.
  It does not print page content. It then waits for a line on standard input
  (only when a terminal is attached) or for `SIGUSR2`. `SIGUSR1` is not used
  because Node reserves it for its debugger.
- **Resume.** The engine reloads and validates the script file. The steps
  before the stuck one must be identical to those already played; otherwise
  the resume is refused, the reason is printed, and the pause continues. An
  invalid script is handled the same way. Before retrying the stuck step, the
  engine runs again every earlier `run` step whose captured variable the
  stuck step uses, so a one-time code is fresh. A value captured by `start`
  cannot be refreshed; if that background command has exited, the resume
  fails and says so.
- **Pause time limit.** When it passes, the run ends with exit code 1.
  Background commands keep running during a pause and may reach their own
  time limits; the pause output names the background commands still running.
- **Command output.** Standard output is captured or discarded, never
  printed. Standard error is read for `capture_match` and otherwise
  discarded. A failed command is reported by its exit code only.
- **Shutdown.** On normal exit, `SIGINT` and `SIGTERM` the engine ends the
  background commands it started, and the command running in the foreground.
  After a signal the process exits with 130 (`SIGINT`) or 143 (`SIGTERM`).
- **Order at start.** Load and validate the script, run the precondition,
  then locate the daemon and check readiness. The precondition comes first so
  that "already satisfied" exits with code 10 even when the daemon or Brave
  is not running.
- **Output.** One line when a step starts and one when it ends, with the step
  number, step type and elapsed time. A failure shows a code (the daemon's
  error code, or a harness code such as `NOT_CLICKED` or `COMMAND_EXIT`);
  the daemon's message text is never printed. Progress goes to standard
  output; the final failure reason and script problems go to standard error.
- **Background match.** A `start` step judges its pattern 250 ms after the
  first matching text appears; a second distinct match within that time
  fails the step.

### Error Handling

Three classes, each with one outcome:

1. **Script problems** — found by the loader before any step; exit 2.
2. **Infrastructure problems** — daemon unreachable, token rejected,
   extension not connected, at start or mid-run; exit 3.
3. **Step failures** — handled by the step's `on_failure`, default stop;
   exit 1.

### Testing Strategy

Tests are written first (profile: TDD), with Node's built-in test runner over
the compiled test files, wired to the package's `verify` script so
`npm run verify:harness` matches the other packages.

- **Unit** — loader (valid and invalid scripts), mask (plain and URL-encoded
  forms), command runner (a value containing `;` or spaces stays one
  argument; a pattern on the error stream is captured; the token variable is
  absent from the child environment), daemon client (time limit, error
  mapping, defaults filled from the protocol schema).
- **Integration** — engine against the fake daemon and stand-in commands:
  the login-shaped sequence; each "Fails when" rule; each failure setting;
  pause, resume, refused resume after an edit of played steps, re-capture
  before retry, pause time limit; exit codes; no secret in output.
- **Real browser** — the login-shaped script against real Brave and a local
  fixture site with a stand-in login command, kept in
  `apps/harness/fixtures/` as plain JavaScript (outside the TypeScript build).
- **Real AWS** — run by the operator.

### Verification Approach

| Requirement | Method | Scope | Expected Evidence |
|---|---|---|---|
| FR-1: load and validate before running | `auto-test` | unit | invalid scripts rejected with step number; fake daemon received zero calls |
| FR-2: browser steps via daemon RPC | `auto-test` | integration | fake daemon call log matches the script; every call carries all parameters |
| FR-3: `run`, `start`, `await` | `auto-test` | integration | captured values match stand-in output on either stream; background exit observed |
| FR-4: variables in later steps | `auto-test` | integration | fake daemon received the captured value in the `type` call |
| FR-5: target tab, `use_tab` | `auto-test` | integration | matching tab adopted; URL opened when none matches within the limit |
| FR-6: stop, retry, alternatives, pause | `auto-test` | integration | one test per outcome; resume re-captures; edited played steps refuse resume |
| FR-7 / Story 3: masking, no command output echoed | `auto-test` | integration | captured values and stand-in command output absent from all harness output, including a failed run |
| FR-7: no secret in daemon log or extension status | `manual-run-claude` | real browser | daemon log and extension status after a fixture run searched for the stand-in secret: absent |
| FR-8 / Story 6: one invocation, exit codes | `auto-test` | integration | one test per code; process exits after one script |
| FR-9: precondition | `auto-test` | integration | exit 10, fake daemon received zero calls |
| Story 2: login-shaped flow | `manual-run-claude` | real browser | fixture script reaches the success marker in real Brave |
| Story 2: AWS login | `manual-run-user` | real AWS | operator's script exits 0; CLI reports updated credentials |
| Story 4: never the active tab | `auto-test` | integration | a script whose first browser step is not `open_tab` or `use_tab` is rejected |
| Story 4: profile setup guide | `code-only` | — | — |
| Story 5 / NFR-4: nothing on disk | `auto-test` | integration | working directory and temp directory unchanged after a paused and resumed run |
| NFR-1: flow defined in YAML only | `auto-test` | integration | the fixture flow runs from a YAML file with no code |
| NFR-2: no shell | `auto-test` | unit | argument with shell characters arrives as one argument |
| NFR-3: no risky step types | `auto-test` | unit | a script naming one is rejected |
| NFR-5: typed error drives failure setting | `auto-test` | integration | covered by FR-6 tests |
| NFR-6: testable without a browser | `auto-test` | integration | the whole auto-test suite runs with no browser |
| NFR-7: workspace package | `code-only` | — | — |
| Assumption: CLI honours the browser-suppressing variable | `manual-run-user` | real AWS | no tab opens in the everyday profile |
| Assumption: CLI prints the URL promptly without a terminal | `manual-run-user` | real AWS | `start` captures the URL within its time limit |

## Trade-offs

**Daemon client**
- *Own client in the harness (chosen).* Fills parameters from the protocol
  schemas and keeps the error code. Cost: a second small client in the repo.
- *Reuse the MCP client.* Rejected: it loses the error code, has no time
  limit, and changing it would alter MCP server behaviour.

**Test double**
- *Scripted fake daemon in the harness (chosen).* Can play "absent, then
  present" and record calls.
- *Real daemon plus the SDK's simulated extension.* Rejected: its replies
  cannot be scripted per test.

**`aws login` page**
- *Capture the URL, `use_tab` with a URL prefix (chosen).* Works whichever
  profile the system browser opens, and still matches after redirects.
- *Match the tab by the exact captured URL.* Rejected: after a redirect the
  tab's URL differs, and a second tab would be opened.
- *Let the CLI open the browser and search for the tab.* Rejected: the tab
  may be in a profile the harness cannot see.
- *`--remote`.* Rejected: needs two more step types.

**Wait-for-selector**
- *Repeated short waits (chosen).* Survives navigation and daemon timeouts.
- *One long wait.* Rejected: a navigation may end it early.

**Script as YAML**
- *YAML player (chosen, owner's decision).* A flow is data an agent can write
  and a person can review without reading code.
- *Client library with scripts as code.* Recommended by the independent
  critique; not taken. Its cost — resume keyed to position, stale values,
  retry of typing — is handled by the rules above.

## Implementation Constraints

- The daemon serves one profile; the harness assumes the paired extension is
  the automation profile's.
- A scheduled run needs the daemon running and Brave open with the
  automation profile; the harness starts neither and exits with code 3 when
  the extension is not connected. A script may start Brave itself with a
  `run` step.
- A captured value used as a command argument is visible in the system's
  process list while that command runs. The AWS script does not need this.
- A short captured value (a six-digit code) is masked wherever it appears in
  output, including by coincidence.
- Typed text travels harness → daemon → extension on localhost in clear text,
  as for every existing client.
- If the CLI holds back its output when no terminal is attached, the `start`
  step will need to give the command a pseudo-terminal; this is added only if
  the real run shows the delay.
- Whether `dom.type` produces the input events the AWS sign-in form requires
  is unknown until the real run. If it does not, the fix is in the extension
  and is a separate change.
- CAPTCHA or a risk challenge ends in the step's failure setting.

## Files to Create/Modify

**Create**
- `apps/harness/package.json` (its `build` builds `packages/protocol` first,
  like the other packages), `tsconfig.json`, `README.md`
- `apps/harness/src/index.ts`, `script.ts`, `engine.ts`, `daemon-client.ts`,
  `commands.ts`, `mask.ts`
- `apps/harness/src/test/fake-daemon.ts` and one test file per component
- `apps/harness/fixtures/` — fixture site, stand-in commands (plain
  JavaScript), fixture script

**Modify**
- `package.json:14-25` — add `build:harness`, `verify:harness`
- `README.md` — repository layout and verification sections

## Dependencies

**External**
- `yaml` ^2.8 — YAML parsing; `parse` reports syntax errors with line and
  column (checked in the library documentation via Context7).
- `zod` ^3.24 — script schemas; same version line as the daemon.

**Internal**
- `@brave-mcp/protocol` — method names, input schemas, response schema, error
  codes.

## Security Considerations

- Commands run without a shell; a captured value cannot add a command.
- The operator's approval of the script is the safeguard for which commands
  run and which sites are visited.
- No risky browser step types in v1.
- Captured values exist only in process memory and in the browser field they
  fill. Nothing is written to disk, including during a pause.
- Pause output shows the tab address without its query part, and the title.
- The pairing token is read at start, never printed, and not passed to child
  commands.

## Performance Considerations

None of note: a run is a few dozen local HTTP calls and child processes.

## Rollback Plan

The feature is one new package plus two root script lines. Removing them
restores the previous state; no existing package changes behaviour.

## References

- `apps/daemon/src/app.ts` — connection, readiness and time-limit behaviour.
- `apps/extension/src/background.ts:1380-1441,4231-4260` — wait-for-selector
  and error codes.
- `packages/protocol/src/tools.ts`, `rpc.ts` — input schemas and error codes.
- `apps/mcp/src/daemon-client.ts`, `config.ts` — the client this design does
  not reuse, and how the daemon is located.

---

**Next Steps**:
1. Review and approve this design.
2. Run `/embo:tasks` for the task breakdown.

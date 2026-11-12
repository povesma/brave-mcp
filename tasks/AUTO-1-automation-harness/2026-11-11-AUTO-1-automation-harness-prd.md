# AUTO-1: Browser Automation Harness - PRD

**Status**: Draft (revised after independent critique)
**Created**: 2026-11-11
**JIRA**: AUTO-1 (placeholder — rename to the real ticket when assigned)
**Author**: Claude (via embo workflow analysis)

---

## Wider Context / Higher Goal

This harness is a **general, reusable browser-automation capability**, not a
one-off AWS helper. The AWS login + MFA flow is its first script and its
acceptance scenario; more browser-plus-CLI automations follow. An AI agent
writes and refines the scripts. At run time the harness plays a script with no
AI agent involved.

## Context

Logging into AWS (and similar MFA-gated sites) is a manual sequence: navigate,
type credentials, wait for the MFA field, fetch a one-time code from a CLI,
type it, submit, then run a follow-up CLI that opens a page and click an
element there. It must be repeated before auth expires, and it mixes browser
actions with local shell commands. The `brave-mcp` stack can drive the browser
from an AI agent, but it has no way to record such a flow as a repeatable
script that runs without an agent.

### Current State (observed)

- The daemon RPC lists 48 method names covering navigation, DOM interaction,
  waiting and capture — verified via: `specs/rpc/daemon-rpc.schema.json:29-77`,
  2026-11-11. That file holds method names only; the parameters of each method
  are defined in `packages/protocol/src/tools.ts`.
- Opening a tab takes a URL and an "active" flag only; it cannot name a window
  — verified via: `packages/protocol/src/tools.ts:86-89`, 2026-11-11.
- Waiting for a selector returns a `found` boolean — verified via:
  `packages/protocol/src/tools.ts:246-248`, 2026-11-11. Whether a timeout
  returns `found: false` or a timeout error is
  [assumption, verify in tech-design].
- Every RPC carries an auth token, and the daemon returns one of 7 typed error
  codes (auth required, extension offline, tab not found, selector not found,
  timeout, permission denied, internal error), each with a `retryable` flag —
  verified via: `specs/rpc/daemon-rpc.schema.json:85-171`, 2026-11-11.
- The daemon keeps a single extension connection; a new connection closes the
  previous one — verified via: `apps/daemon/src/app.ts:140-143`, 2026-11-11.
  One daemon therefore drives exactly one Brave profile: the profile in which
  the connected extension is installed.
- The extension holds broad authority (all URLs, debugger, cookies, scripting)
  — verified via: `apps/extension/static/manifest.json:6-20`, 2026-11-11.
  Any client of the paired daemon can drive every session in that profile.
- The existing daemon client in the MCP server has no request timeout, does
  not keep the `retryable` flag, and builds request ids from the clock —
  [assumption, verify in tech-design] (reported by the independent critique of
  `apps/mcp/src/daemon-client.ts`, not re-checked).
- The repo is an npm-workspace monorepo (`apps/*`, `packages/*`) with shared
  protocol types — verified via: `package.json:6-9`, 2026-11-11.

### Past Similar Features (from claude-mem)

None. Project memory was seeded this session and holds no earlier PRDs.

## Problem Statement

**Who**: An operator who repeatedly logs into MFA-gated web services (AWS
first).
**What**: The login flow mixes browser actions with local CLI calls, and it
cannot be recorded as a repeatable script that runs without an agent.
**Why**: Manual MFA login is slow and error-prone and must be redone before
auth expires. Needing a person or an AI agent for every run does not scale to
many flows.
**When**: Whenever auth is needed or about to expire, including on a schedule.

## Goals

### Primary Goal

A **harness** that plays a YAML script: an ordered list of **browser steps**
(sent to the daemon RPC) and **shell steps** (local commands whose output is
captured and passed to later steps), with no AI agent at run time.

### Secondary Goals

- Make the AWS login + `ente` MFA flow scriptable end to end.
- Keep scripts as plain YAML that an AI agent or a person can write and edit.
- Keep automation away from the operator's everyday logged-in sessions by
  running it in a dedicated Brave profile.
- Be re-runnable as a single command so an external scheduler can refresh auth.

## User Stories

### Epic

As an operator, I want to record a browser-plus-CLI login flow as a YAML script
that a harness plays on demand, so that MFA-gated logins run repeatably without
me or an AI agent performing each step.

### User Stories

1. **As an** operator
   **I want** to write a YAML script listing browser and shell steps
   **So that** a whole login flow is described as data, not code.

   **Acceptance Criteria**:
   - [ ] A script is an ordered list of steps, played top to bottom.
   - [ ] The set of browser step types is a fixed, documented list; a script
         using a step type outside the list is rejected before anything runs.
   - [ ] A `run` step executes a command and captures its standard output into
         a named variable.
   - [ ] A later step can use a captured variable as a field value.
   - [ ] An invalid script (unknown step, missing field, unknown variable) is
         rejected with the step number and reason, before any step runs.

2. **As an** operator
   **I want** the harness to play the AWS login + `ente` MFA flow end to end
   **So that** I get a logged-in AWS session without typing credentials or codes.

   **Acceptance Criteria**:
   - [ ] Automated test: the same step sequence (navigate, capture two values
         from commands, type them, click, wait for a second field, capture a
         code from a command, type it, submit, wait for a success marker) passes
         against a local fixture page and stand-in commands.
   - [ ] Manual check: the real script runs against real Brave and AWS and
         reaches the success marker named in the script.
   - [ ] A command can be started in the background, a value (the sign-in
         URL) captured from its output while it runs, and its exit awaited by
         a later step.
   - [ ] A step makes the tab showing a given URL the target; when no such
         tab appears in the automation profile within a time limit, the
         harness opens the URL in a new tab there.

3. **As an** operator
   **I want** captured values masked in all harness output
   **So that** passwords and one-time codes never reach logs or capture files.

   **Acceptance Criteria**:
   - [ ] A value captured by a `run` step never appears in logs, error
         messages or saved output; a fixed mask is shown instead.
   - [ ] The real value is still sent to the browser field it fills.
   - [ ] The standard output and error output of `run` commands are not
         echoed to harness output.

4. **As an** operator
   **I want** automation confined to a dedicated Brave profile
   **So that** a script can never touch my everyday logged-in sessions.

   **Acceptance Criteria**:
   - [ ] The setup guide describes creating an automation profile, installing
         the extension only there, and pairing it to the daemon.
   - [ ] A script opens its own tab and all later steps act on that tab unless
         a step explicitly changes the target.
   - [ ] The harness never acts on the active tab by default.

5. **As an** operator
   **I want** each step to say what happens when it fails
   **So that** a slow or changed page does not silently break the flow.

   **Acceptance Criteria**:
   - [ ] A step with no failure setting stops the run and reports the step
         number and the daemon's error code.
   - [ ] A step can declare a retry count and wait between tries.
   - [ ] A step can declare alternative selectors, tried in order.
   - [ ] A step can declare "pause": the harness process stays running, keeps
         its captured values in memory only, reports the stuck step, and waits.
         On a resume signal it reloads the script file and continues from the
         stuck step.
   - [ ] Nothing about a paused run is written to disk. If the process ends
         during a pause, the run is lost and must be started again.

6. **As an** operator
   **I want** the harness to be a single re-runnable command
   **So that** an external scheduler can refresh auth before it expires.

   **Acceptance Criteria**:
   - [ ] One invocation plays one script and exits.
   - [ ] Documented exit codes distinguish: success, already satisfied, script
         invalid, step failed, daemon or extension unavailable.
   - [ ] A script can start with a precondition check ("already logged in").
         When the check passes, the run ends at once with the "already
         satisfied" code and performs no further steps.

## Requirements

### Functional Requirements

1. **FR-1**: YAML script loading and validation before any step runs.
   - **Priority**: High
   - **Rationale**: A half-played login is worse than a rejected script.

2. **FR-2**: Browser steps executed through the daemon RPC, from a fixed list
   of step types.
   - **Priority**: High
   - **Dependencies**: daemon RPC, pairing token, shared protocol types.

3. **FR-3**: `run` step — execute a command and capture its standard output
   into a named variable.
   - **Priority**: High
   - **Rationale**: Credentials and the one-time code come from CLIs. A
     command can also be started in the background and awaited later, because
     `aws login` prints its URL and keeps running until the browser flow ends.

4. **FR-4**: Captured variables usable as values in later steps.
   - **Priority**: High

5. **FR-5**: Explicit target tab — a script opens its tab and the harness
   carries it through later steps; a step can adopt the tab showing a given
   URL, or open that URL when no such tab exists in the automation profile.
   - **Priority**: High
   - **Rationale**: The last part of the AWS flow acts on a page that a CLI
     opens.

6. **FR-6**: Per-step failure handling — stop (default), retry, alternative
   selectors, in-memory pause and resume.
   - **Priority**: High
   - **Rationale**: These are settings of a single step. They do not add
     general branching to scripts.

7. **FR-7**: Masking of captured values in all output.
   - **Priority**: High

8. **FR-8**: Single-invocation command with documented exit codes.
   - **Priority**: Medium

9. **FR-9**: Optional precondition check that ends the run early as "already
   satisfied".
   - **Priority**: Medium
   - **Rationale**: A scheduled re-run while still logged in meets a different
     page; without this check a linear script fails.

### Non-Functional Requirements

1. **NFR-1 (Usability)**: A flow is defined entirely in YAML; no code.
2. **NFR-2 (Security — commands)**: The operator writes and approves each
   script; that approval is the main safeguard. The harness runs every command
   as a program plus a list of arguments and never through a shell, so a
   captured value is always passed as one argument and cannot add commands.
3. **NFR-3 (Security — browser steps)**: Step types that run arbitrary page
   code, read cookies, or export session data are not available to scripts by
   default.
4. **NFR-4 (Security — secrets)**: The harness stores no secrets. Captured
   values live in process memory only and are never written to disk. The
   pairing token is read from the daemon's config file at run time.
5. **NFR-5 (Reliability)**: A browser-step failure is reported with the
   daemon's typed error and handled by the step's failure setting.
6. **NFR-6 (Testability)**: The script engine can be tested without a browser,
   against a stand-in daemon.
7. **NFR-7 (Fit)**: A new workspace package in this monorepo, reusing the
   shared protocol types.

### Technical Constraints

- Must integrate with: the daemon's localhost RPC and its typed errors.
- Should follow patterns: workspace package layout; shared protocol types.
- The daemon RPC may be extended where the AWS flow needs it; any extension
  follows the project rule that a tool exists in all four layers (protocol,
  daemon, extension, MCP).
- One daemon serves one profile. The automation profile gets its own paired
  extension; the extension is not installed in the everyday profile.
- The AWS CLI opens its page through the system default browser, possibly in
  the wrong profile. The harness cannot see or close a tab there; it opens the
  same URL in the automation profile. The script tries to stop the CLI from
  launching a browser; whether the CLI honours that is
  [assumption, verify during implementation].

## Out of Scope

- **The harness calling an AI agent by itself** — planned for a later version.
- **Saving a paused run to disk** or resuming it in a new process.
- **Several profiles in one run.**
- **Secret storage** — the harness only runs commands that print secrets.
- **A GUI or visual script editor.**
- **A built-in scheduler** — cron, launchd or a similar tool invokes the
  harness.
- **General branching, conditionals and loops in scripts.**
- **CAPTCHA and risk challenges** on the login page — a run that meets one
  stops or pauses according to the step's failure setting.

## Success Metrics

1. The AWS login + `ente` MFA script reaches its success marker against real
   Brave with no manual input.
2. No captured value appears in any harness log or output file across a full
   run, including a run with a failed step.
3. Every failed step ends in exactly one documented outcome: stop, successful
   retry, successful alternative selector, or pause. No step is skipped
   silently.

## References

### From Codebase

- `specs/rpc/daemon-rpc.schema.json` — RPC method names, auth token, error set.
- `packages/protocol/src/tools.ts` — per-method parameters and results.
- `apps/daemon/src/app.ts` — single extension connection per daemon.
- `apps/mcp/src/daemon-client.ts` — existing daemon client; reuse or replace is
  a tech-design decision.
- `packages/sdk` — includes a simulated extension used in tests; a candidate
  for the stand-in daemon. [assumption, verify in tech-design]
- `apps/extension/static/manifest.json` — the authority the extension holds.

### From History (Claude-Mem)

- None.

---

**Next Steps**:
1. Review and approve this PRD.
2. Run `/embo:tech-design` (script format, harness structure, daemon client,
   pause and resume mechanism, find-tab step, AWS CLI page and profile).
3. Run `/embo:tasks`.

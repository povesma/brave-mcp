# @brave-mcp/harness

`brave-mcp-play` plays a YAML script: an ordered list of browser steps and
local commands. It needs no AI agent. Browser steps are sent to the local
`brave-mcp` daemon; commands are started directly, never through a shell.

One process plays one script from the first step to the last, keeps captured
values (passwords, one-time codes) in memory only, and exits with a code that
states the outcome.

## Build and verify

From the repository root:

```sh
npm install
npm run build:harness     # builds the protocol package, then the harness
npm run verify:harness    # builds, then runs the test suite (no browser needed)
```

The tests use a scripted stand-in for the daemon and stand-in commands from
`fixtures/commands/`. They write temporary script files to `apps/harness/tmp/`
(git-ignored) and remove them.

## Usage

```sh
node apps/harness/dist/index.js <script.yaml>
```

Before it plays any browser step, the harness needs:

- the daemon running (the harness never starts it),
- Brave open with the paired extension connected.

The daemon is found the same way the MCP server finds it:

| Environment variable | Meaning | Default |
|---|---|---|
| `BRAVE_MCP_DAEMON_URL` | Daemon address | `http://127.0.0.1:39200` |
| `BRAVE_MCP_CONFIG_DIR` | Folder holding `daemon-config.json` (the pairing token) | `~/.local/share/brave-mcp` |
| `BRAVE_MCP_AUTH_TOKEN` | Token, used in place of the config file | — |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Script completed |
| 1 | A step failed (including a pause that reached its time limit) |
| 2 | Script invalid or no script given; nothing was run |
| 3 | Daemon or extension unavailable |
| 10 | Precondition passed: already satisfied, no step ran |
| 130 / 143 | Stopped by `SIGINT` / `SIGTERM`; all started commands were ended |

### Order at start

1. The script is loaded and fully validated. Any problem is printed with its
   step number and the harness exits with code 2.
2. The `precondition` command runs, if the script has one. Exit 0 means the
   goal is already met: the harness exits with code 10.
3. The daemon is located and asked whether the extension is connected and
   paired. If not, the harness exits with code 3.
4. The steps are played in order.

## Script format

```yaml
name: example-login
pause_timeout_s: 600            # optional, default 600

precondition:                   # optional
  cmd: [check-credentials]

steps:
  - open_tab: { url: "https://signin.example.com" }
  - run: { cmd: [get-user], capture: user }
  - type: { selector: "#username", text: "${user}" }
  - click: { selector: "#signin" }
  - wait_for:
      selector: "#mfa"
      timeout_s: 30
      on_failure:
        selectors: ["input[name=mfaCode]"]
        retry: { times: 2, wait_s: 3 }
        then: pause
```

A complete example is [fixtures/login.yaml](fixtures/login.yaml).

### Step types

There are eleven step types. Any other name is rejected, and so is any field
that is not listed here. Steps that run page code, read cookies or export
session data do not exist.

| Step | What it does | Required fields | Optional fields (default) | Fails when |
|---|---|---|---|---|
| `open_tab` | Opens a URL in a new tab; that tab becomes the target | `url` | — | daemon error, or no valid tab id |
| `use_tab` | Makes the tab whose address starts with `url_prefix` the target; if none appears within `wait_s`, opens `open` in a new tab | `url_prefix`, `open` | `wait_s` (3) | daemon error, or more than one tab matches |
| `navigate` | Loads a URL in the target tab | `url` | `timeout_s` (30) | daemon error, or the load timed out |
| `wait_for` | Waits until an element is visible (or only present) | `selector` | `state`: `visible` or `attached` (`visible`), `timeout_s` (30) | not found when `timeout_s` has passed |
| `type` | Clears the field, then types text | `selector`, `text` | — | daemon error, or nothing was typed |
| `click` | Clicks an element | `selector` | — | daemon error, or nothing was clicked |
| `press_key` | Presses a key | `key` | `modifiers`: list of `Alt`, `Control`, `Meta`, `Shift` | daemon error, or nothing was pressed |
| `close_tab` | Closes the target tab | — | — | daemon error, or the tab was not closed |
| `run` | Runs a command to its end; `capture` stores its standard output in a variable | `cmd` | `capture`, `env`, `timeout_s` (60) | non-zero exit, time limit, command not found, or an empty capture |
| `start` | Starts a command in the background; `capture_match` stores the first output text matching a pattern | `id`, `cmd` | `env`, `capture_match` (`var`, `pattern`), `timeout_s` (30) | no match within `timeout_s`, more than one distinct match, or the command exits first |
| `await` | Waits for a background command to exit | `id` | `timeout_s` (120) | non-zero exit or time limit |

Rules the loader enforces:

- **Target tab.** Every browser step acts on the target tab only. A browser
  step before any `open_tab` or `use_tab`, or after `close_tab` without a new
  one, is rejected. The harness never acts on the tab you are looking at
  unless a script adopts it with `use_tab`.
- **Commands.** `cmd` is a list: the program, then its arguments. No shell is
  involved, so `;`, `$(...)` and quotes in an argument have no effect.
- **`start` ids** are unique; `await` names an earlier `start`.
- **`wait_for`** is carried out as repeated short waits, so a page load in the
  middle does not end it early. Only its own `timeout_s` makes it fail.
- **`use_tab`**: choose a `url_prefix` that matches the wanted page only. A
  tab left open by an earlier step that also matches would be adopted, or
  would make two matches.

### Variables

- `capture` (on `run`) stores the whole standard output, without its last line
  break. `capture_match` (on `start`) stores the text that matched `pattern`
  (a JavaScript regular expression) on standard output or standard error.
- `${name}` is replaced inside `url`, `open`, `text`, command arguments and
  `env` values. A variable must be captured by an earlier step; it cannot be
  used in `precondition`.
- Selectors and `url_prefix` are not substituted.

### What happens when a step fails: `on_failure`

Every step accepts `on_failure`:

| Field | Meaning | Default |
|---|---|---|
| `selectors` | Alternative selectors, tried in order after the main one (`wait_for`, `type`, `click` only) | none |
| `retry.times` | How many more rounds to try. One round is the main selector, then each alternative | 0 |
| `retry.wait_s` | Wait between rounds | 1 |
| `then` | When every round has failed: `stop` (exit 1) or `pause` | `stop` |

## Output and secrets

- One line when a step starts and one when it ends, with step number, step
  type and elapsed time. A failure shows a code such as `NOT_CLICKED`,
  `NOT_FOUND`, `COMMAND_EXIT` or the daemon's error code. The daemon's
  message text and page content are never printed.
- Command output is never printed. A failed command is reported by its exit
  code only.
- Every captured value is replaced by `***` in all output, as captured and in
  URL-encoded form. So is the daemon token.
- Captured values exist only in the harness's memory and in the browser field
  they fill. Nothing is written to disk, also not during a pause.
- A command does not receive the harness's `BRAVE_MCP_AUTH_TOKEN` variable.

## Pause and resume

A step with `on_failure: { then: pause }` does not end the run when it fails.
The harness keeps running and prints:

- the step number, step type and failure code,
- the target tab's address without its query part, and its title,
- the ids of background commands still running,
- how to resume.

To continue:

1. Correct the script file (for example the selector of the stuck step).
2. Press Enter in the harness's terminal, or send it `SIGUSR2`
   (`kill -USR2 <pid>`; the pid is in the pause output).

On resume the harness reloads the script file, then:

- **Refuses, and stays paused**, when the file is invalid, or when the steps
  before the stuck one differ from those already played. The reason is
  printed. Only the stuck step and later steps may be changed.
- **Runs again** every earlier `run` step whose captured variable the stuck
  step uses, so a one-time code is fresh. If such a command fails, the resume
  is refused and the pause continues.
- **Ends the run with exit code 1** when the stuck step uses a value captured
  by a `start` step whose command has since exited: that value cannot be
  renewed.
- Then retries the stuck step with its full `on_failure` setting.

The pause ends with exit code 1 when `pause_timeout_s` has passed. Background
commands keep running during a pause and may reach their own time limits.

## Fixtures: a login-shaped flow without a real service

`fixtures/` holds a local sign-in site, stand-in commands and a script that
has the same shape as a real login (two captured values, a one-time-code
field that appears late, then a command-line login that prints a URL and
waits for the browser).

| File | Purpose |
|---|---|
| `fixtures/site-server.mjs` | Sign-in site on `http://127.0.0.1:39310/`. Prints one line per request; stops by itself after `--time-limit-s` (300) |
| `fixtures/commands/fake-cli-login.mjs` | Prints a sign-in URL on standard error, serves a confirm page on port 39311, exits 0 after the confirm button is clicked |
| `fixtures/login.yaml` | The flow |
| `fixtures/commands/*.mjs` | Small stand-in commands used by the script and the tests; each file starts with a comment that says what it does |
| `fixtures/daemon-config/` | A sample daemon config file used by a test |

To play it against real Brave (the daemon must be running and the extension
connected), from `apps/harness`:

```sh
node fixtures/site-server.mjs            # terminal 1
node dist/index.js fixtures/login.yaml   # terminal 2
```

The run opens two tabs in the profile the extension is installed in, closes
both, and exits 0.

To see a pause: copy `fixtures/login.yaml` to `local/login-pause.yaml`, change
the `#mfa` selector of the `wait_for` step to `#wrong`, and play the copy.
When the pause report appears, change the selector back, save, and press
Enter.

## Dedicated Brave profile

The extension can read and control every tab of the profile it is installed
in, and the daemon has no further guard. Keep automation away from your
everyday browsing by giving it its own profile:

1. **Create the profile.** In Brave open the profile menu (top right) and
   choose to add a new profile. Name it, for example, `Automation`. A new
   window of that profile opens. An existing profile kept for this work can
   be used instead; skip this step then.
2. **Load the extension there only.** In the automation window open
   `brave://extensions`, turn on `Developer mode`, choose `Load unpacked` and
   select `apps/extension/dist`.
3. **Pair it with the daemon.** Open the extension's options page and enter
   the daemon address `ws://127.0.0.1:39200/extension/connect` and the token:
   the `secret` value in `daemon-config.json` in the daemon config folder.
4. **Remove the extension from the everyday profile.** In a window of your
   everyday profile open `brave://extensions` and remove `brave-mcp`. The
   daemon serves one extension connection at a time; with the extension in
   two profiles, the one that connected last would be driven.
5. **Check.** `curl -s http://127.0.0.1:39200/readyz` shows
   `"extensionConnected": true` and `"paired": true`, and a tab list (the
   `list_tabs` tool of the MCP server) shows only the automation profile's
   tabs.

For an unattended run (for example from a scheduler) the daemon must be
running and Brave must be open with a window of the automation profile. The
harness starts neither, and exits with code 3 when the extension is not
connected. A script may start Brave itself with a `run` step.

## AWS login script

[scripts/aws-login.template.yaml](scripts/aws-login.template.yaml) is a
template with placeholders. Copy it to `local/` (git-ignored), fill it in, and
play it:

```sh
mkdir -p local
cp scripts/aws-login.template.yaml local/aws-login.yaml
node dist/index.js local/aws-login.yaml
```

Two points are known only after the first real run and are recorded in the
task list: whether `aws login` honours `BROWSER: "true"` (no tab in the
everyday profile), and whether it prints its URL promptly when no terminal is
attached.

## Limitations

- One daemon serves one Brave profile; the harness assumes the connected
  extension is the automation profile's.
- A captured value used as a command argument is visible in the system
  process list while that command runs.
- A short captured value (a six-digit code) is masked wherever the same
  characters appear in output, also by coincidence.
- Typed text travels from the harness to the daemon to the extension on
  localhost in clear text, as for every client of the daemon.
- A `start` step judges its pattern 250 ms after the first match appears; a
  second, different match after that is not noticed.
- A command that holds back its output when no terminal is attached may make
  `capture_match` reach its time limit.
- A CAPTCHA or a risk challenge is not handled; it ends in the step's
  `on_failure` setting.
- Resume by `SIGUSR2` is not available on Windows.

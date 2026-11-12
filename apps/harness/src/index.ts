#!/usr/bin/env node
import { EventEmitter } from "node:events";

import { CommandFailure, CommandRunner } from "./commands.js";
import { DaemonClient, DaemonError, DaemonUnavailableError, locateDaemon } from "./daemon-client.js";
import { Engine, type ResumeSignal } from "./engine.js";
import { SecretMask } from "./mask.js";
import { formatProblem, loadScript } from "./script.js";

const EXIT_COMPLETED = 0;
const EXIT_STEP_FAILED = 1;
const EXIT_SCRIPT_INVALID = 2;
const EXIT_UNAVAILABLE = 3;
const EXIT_ALREADY_SATISFIED = 10;
const EXIT_BY_SIGNAL = { SIGINT: 130, SIGTERM: 143 } as const;

const mask = new SecretMask();
const runner = new CommandRunner();
const resumeRequests = new EventEmitter();

function say(line: string): void {
  process.stdout.write(`${mask.apply(line)}\n`);
}

function sayError(line: string): void {
  process.stderr.write(`${mask.apply(line)}\n`);
}

function exit(code: number): void {
  process.exitCode = code;
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
}

function waitForResume(timeLimitMs: number): Promise<ResumeSignal> {
  return new Promise((resolve) => {
    const terminal = process.stdin.isTTY;
    const finish = (signal: ResumeSignal): void => {
      clearTimeout(timer);
      resumeRequests.off("resume", onResume);
      if (terminal) {
        process.stdin.off("data", onResume);
        process.stdin.pause();
      }
      resolve(signal);
    };
    const onResume = (): void => finish("resume");
    const timer = setTimeout(() => finish("time_limit"), timeLimitMs);
    resumeRequests.on("resume", onResume);
    if (terminal) {
      process.stdin.on("data", onResume);
    }
  });
}

async function connectToDaemon(): Promise<DaemonClient | undefined> {
  try {
    const location = await locateDaemon();
    mask.register(location.authToken);
    const client = new DaemonClient(location);
    if (await client.connected()) {
      return client;
    }
    sayError("unavailable: the extension is not connected and paired");
  } catch (error) {
    if (!(error instanceof DaemonUnavailableError) && !(error instanceof DaemonError)) {
      throw error;
    }
    sayError(`unavailable: ${error.message}`);
  }
  return undefined;
}

async function main(): Promise<number> {
  const scriptPath = process.argv[2];
  if (scriptPath === undefined) {
    sayError("Usage: brave-mcp-play <script.yaml>");
    return EXIT_SCRIPT_INVALID;
  }

  const loaded = await loadScript(scriptPath);
  if (!loaded.ok) {
    sayError(`script invalid, nothing was run (${loaded.problems.length} problem(s)):`);
    for (const problem of loaded.problems) {
      sayError(`  ${formatProblem(problem)}`);
    }
    return EXIT_SCRIPT_INVALID;
  }
  const script = loaded.script;
  say(`script "${script.name}": ${script.steps.length} steps`);

  if (script.precondition) {
    try {
      await runner.run({
        cmd: script.precondition.cmd,
        timeoutMs: script.precondition.timeout_s * 1000,
        ...(script.precondition.env ? { env: script.precondition.env } : {}),
      });
      say("precondition passed: already satisfied, no step ran");
      return EXIT_ALREADY_SATISFIED;
    } catch (error) {
      if (!(error instanceof CommandFailure)) {
        throw error;
      }
      say(`precondition not satisfied (${error.message}); playing the script`);
    }
  }

  const client = await connectToDaemon();
  if (!client) {
    return EXIT_UNAVAILABLE;
  }

  const engine = new Engine({
    script,
    client,
    runner,
    mask,
    output: say,
    reloadScript: () => loadScript(scriptPath),
    waitForResume,
  });
  const outcome = await engine.run();

  switch (outcome.status) {
    case "completed":
      say(`completed: script "${script.name}"`);
      return EXIT_COMPLETED;
    case "step_failed":
      sayError(`failed at step ${outcome.step} (${outcome.code})`);
      return EXIT_STEP_FAILED;
    case "unavailable":
      sayError(`unavailable: ${outcome.reason}`);
      return EXIT_UNAVAILABLE;
  }
}

// SIGUSR2 without a listener would end the process; outside a pause it is ignored.
process.on("SIGUSR2", () => resumeRequests.emit("resume"));

let stoppedBySignal = false;

for (const [signal, code] of Object.entries(EXIT_BY_SIGNAL)) {
  process.once(signal, () => {
    stoppedBySignal = true;
    sayError(`${signal} received: ending commands and stopping`);
    void runner.stopAll().then(() => exit(code));
  });
}

main().then(
  (code) => {
    if (!stoppedBySignal) {
      exit(code);
    }
  },
  async (error: unknown) => {
    sayError(`internal error: ${error instanceof Error ? error.message : String(error)}`);
    await runner.stopAll();
    if (!stoppedBySignal) {
      exit(EXIT_STEP_FAILED);
    }
  },
);

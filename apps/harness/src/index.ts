#!/usr/bin/env node
import { EventEmitter } from "node:events";

import { profileNicknameSchema } from "@brave-mcp/protocol";

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
const USAGE = "Usage: brave-mcp-play [--profile <nickname>] <script.yaml>";

interface Arguments {
  scriptPath: string;
  profile?: string;
}

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

function parseArguments(args: string[]): Arguments | undefined {
  let scriptPath: string | undefined;
  let profile: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--profile") {
      profile = args[index + 1];
      if (profile === undefined) {
        return undefined;
      }
      index += 1;
    } else if (scriptPath === undefined) {
      scriptPath = arg;
    } else {
      return undefined;
    }
  }
  if (scriptPath === undefined) {
    return undefined;
  }
  return { scriptPath, ...(profile === undefined ? {} : { profile }) };
}

async function connectToDaemon(profile: string | undefined): Promise<DaemonClient | number> {
  try {
    const location = await locateDaemon();
    mask.register(location.authToken);
    const client = new DaemonClient(location, profile === undefined ? {} : { profile });
    const readiness = await client.readiness();
    switch (readiness.status) {
      case "ready":
        return client;
      case "profile_required":
        sayError(
          `several profiles are connected (${readiness.connected.join(", ")}); ` +
            "choose one with --profile or BRAVE_MCP_PROFILE; nothing was run",
        );
        return EXIT_SCRIPT_INVALID;
      case "not_connected":
        sayError(`unavailable: ${readiness.reason}`);
        return EXIT_UNAVAILABLE;
    }
  } catch (error) {
    if (!(error instanceof DaemonUnavailableError) && !(error instanceof DaemonError)) {
      throw error;
    }
    sayError(`unavailable: ${error.message}`);
    return EXIT_UNAVAILABLE;
  }
}

async function main(): Promise<number> {
  const args = parseArguments(process.argv.slice(2));
  if (args === undefined) {
    sayError(USAGE);
    return EXIT_SCRIPT_INVALID;
  }
  const { scriptPath } = args;
  const rawProfile = args.profile ?? (process.env.BRAVE_MCP_PROFILE || undefined);
  let profile: string | undefined;
  if (rawProfile !== undefined) {
    const parsed = profileNicknameSchema.safeParse(rawProfile);
    if (!parsed.success) {
      sayError(`invalid profile nickname: ${parsed.error.issues[0]?.message ?? "not a profile nickname"}`);
      return EXIT_SCRIPT_INVALID;
    }
    profile = parsed.data;
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

  const client = await connectToDaemon(profile);
  if (typeof client === "number") {
    return client;
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

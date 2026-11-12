import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { FakeDaemon } from "./fake-daemon.js";

const ENTRY_PATH = fileURLToPath(new URL("../index.js", import.meta.url));
const SCRIPT_DIR = fileURLToPath(new URL("../../tmp/test-scripts", import.meta.url));
const RUN_TIME_LIMIT_MS = 30_000;

export interface HarnessRun {
  child: ChildProcess;
  output: () => string;
  finished: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

export function daemonEnv(daemon: FakeDaemon): Record<string, string> {
  return { BRAVE_MCP_DAEMON_URL: daemon.url, BRAVE_MCP_AUTH_TOKEN: daemon.token };
}

export async function writeScript(name: string, yaml: string): Promise<string> {
  await mkdir(SCRIPT_DIR, { recursive: true });
  const path = join(SCRIPT_DIR, `${name}.yaml`);
  await writeFile(path, yaml, "utf8");
  return path;
}

export async function removeScript(path: string): Promise<void> {
  await rm(path, { force: true });
}

export function startHarness(args: string[], env: Record<string, string> = {}, cwd?: string): HarnessRun {
  const child = spawn(process.execPath, [ENTRY_PATH, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    ...(cwd ? { cwd } : {}),
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });

  const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIME_LIMIT_MS);
  const finished = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
  return { child, output: () => stdout, finished };
}

export async function runHarness(args: string[], env: Record<string, string> = {}) {
  return startHarness(args, env).finished;
}

export async function until(condition: () => boolean, what: string, timeLimitMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeLimitMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeLimitMs} ms waiting for ${what}`);
    }
    await sleep(20);
  }
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

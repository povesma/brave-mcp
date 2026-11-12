import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { CommandRunner } from "../commands.js";
import { DaemonClient } from "../daemon-client.js";
import { Engine, type EngineOptions, type RunOutcome } from "../engine.js";
import { SecretMask } from "../mask.js";
import { formatProblem, parseScript, type Script } from "../script.js";
import { FakeDaemon } from "./fake-daemon.js";

export interface PlayResult {
  outcome: RunOutcome;
  lines: string[];
  daemon: FakeDaemon;
}

export type PlayOverrides = Partial<Pick<EngineOptions, "reloadScript" | "waitForResume">>;

export function standInPath(name: string): string {
  return fileURLToPath(new URL(`../../fixtures/commands/${name}.mjs`, import.meta.url));
}

// A command written as a YAML flow sequence that starts a stand-in with this Node binary.
export function cmd(name: string, ...args: string[]): string {
  return JSON.stringify([process.execPath, standInPath(name), ...args]);
}

export function scriptOf(yaml: string): Script {
  const result = parseScript(yaml);
  assert.ok(result.ok, result.ok ? "" : result.problems.map(formatProblem).join(" | "));
  return result.script;
}

export async function play(
  yaml: string,
  prepare: (daemon: FakeDaemon) => void,
  overrides: PlayOverrides | ((daemon: FakeDaemon, lines: string[]) => PlayOverrides) = {},
): Promise<PlayResult> {
  const daemon = await FakeDaemon.start();
  const lines: string[] = [];
  const mask = new SecretMask();
  try {
    prepare(daemon);
    const engine = new Engine({
      script: scriptOf(yaml),
      client: new DaemonClient({ daemonUrl: daemon.url, authToken: daemon.token }),
      runner: new CommandRunner(),
      mask,
      output: (line) => lines.push(line),
      waitRoundMs: 60,
      pollMs: 20,
      ...(typeof overrides === "function" ? overrides(daemon, lines) : overrides),
    });
    return { outcome: await engine.run(), lines, daemon };
  } finally {
    await daemon.stop();
  }
}

export interface TestServer {
  url: string;
  hits: string[];
  stop: () => Promise<void>;
}

// A local HTTP server for stand-in commands to call; `respond` receives the hit number (from 1).
export async function startTestServer(
  respond: (hit: number, path: string) => { status?: number; body: string },
): Promise<TestServer> {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? "");
    const reply = respond(hits.length, request.url ?? "");
    response.writeHead(reply.status ?? 200, { "content-type": "text/plain" });
    response.end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function methodsOf(daemon: FakeDaemon): string[] {
  return daemon.calls.map((call) => call.method);
}

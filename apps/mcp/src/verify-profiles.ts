import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION, toolCatalog } from "@brave-mcp/protocol";
import { connectSimulatedExtensionBridge, type SimulatedExtensionBridge } from "@brave-mcp/sdk";

import { resolveRuntimeConfig } from "./config.js";
import { ensureDaemonAvailable } from "./daemon-bootstrap.js";
import { DaemonCallError, DaemonClient } from "./daemon-client.js";
import { getToolDefinitions, handleToolCall } from "./tools.js";

const SCENARIO_TIME_LIMIT_MS = 10_000;
const NETWORK_TIME_LIMIT_MS = 2_000;
const ALPHA = "Alpha";
const BRAVO = "Bravo";
const ABSENT = "Charlie";

interface ProfileEnvironment {
  daemonUrl: string;
  configDir: string;
  secret: string;
  alpha: SimulatedExtensionBridge;
  bravo: SimulatedExtensionBridge;
}

interface StubDaemon {
  url: string;
  envelopes: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

interface ClientOptions {
  defaultProfile?: string;
  profileLocked?: boolean;
}

type Scenario = [string, (env: ProfileEnvironment) => Promise<void>];

function check(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        reject(new Error("Expected a bound server address"));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

export async function waitForHealth(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(NETWORK_TIME_LIMIT_MS) });
      if (response.ok) {
        return;
      }
    } catch {
      // Retry while the daemon is still starting.
    }

    await delay(100);
  }

  throw new Error("Timed out waiting for the daemon health endpoint");
}

async function connectedNicknames(env: Pick<ProfileEnvironment, "daemonUrl" | "secret">): Promise<string[]> {
  const response = await fetch(`${env.daemonUrl}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "verify_profiles_list", method: "profiles.list", params: {}, authToken: env.secret }),
    signal: AbortSignal.timeout(NETWORK_TIME_LIMIT_MS),
  });
  const json = (await response.json()) as { ok: boolean; result?: { profiles: Array<{ nickname: string }> } };
  return json.ok && json.result ? json.result.profiles.map((profile) => profile.nickname) : [];
}

async function waitForProfiles(env: Pick<ProfileEnvironment, "daemonUrl" | "secret">, expected: string[]) {
  const deadline = Date.now() + SCENARIO_TIME_LIMIT_MS;
  while (Date.now() < deadline) {
    const nicknames = await connectedNicknames(env);
    if (expected.every((nickname) => nicknames.includes(nickname))) {
      return;
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for profiles ${expected.join(", ")} to register`);
}

async function startEnvironment(): Promise<{ env: ProfileEnvironment; daemon: ChildProcess }> {
  const configDir = await mkdtemp(join(tmpdir(), "brave-mcp-mcp-profiles-"));
  const port = await getFreePort();
  const daemonUrl = `http://127.0.0.1:${port}`;
  const daemonEntryPath = fileURLToPath(new URL("../../daemon/dist/index.js", import.meta.url));
  const daemon = spawn(
    process.execPath,
    [daemonEntryPath, "--port", String(port), "--config-dir", configDir, "--silent"],
    { stdio: "ignore" },
  );

  await waitForHealth(daemonUrl);
  const { secret } = JSON.parse(await readFile(join(configDir, "daemon-config.json"), "utf8")) as { secret: string };
  const wsUrl = `ws://127.0.0.1:${port}/extension/connect`;
  const alpha = await connectSimulatedExtensionBridge({
    daemonUrl: wsUrl,
    authToken: secret,
    profile: ALPHA,
    tabs: [{ tabId: 101, windowId: 1, title: "Alpha Tab", url: "https://example.test/alpha", active: true }],
  });
  const bravo = await connectSimulatedExtensionBridge({
    daemonUrl: wsUrl,
    authToken: secret,
    profile: BRAVO,
    tabs: [{ tabId: 201, windowId: 2, title: "Bravo Tab", url: "https://example.test/bravo", active: true }],
  });
  const env = { daemonUrl, configDir, secret, alpha, bravo };
  await waitForProfiles(env, [ALPHA, BRAVO]);
  return { env, daemon };
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startStubDaemon(health: Record<string, unknown>): Promise<StubDaemon> {
  const envelopes: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    if (request.url === "/healthz") {
      sendJson(response, 200, health);
      return;
    }
    if (request.url === "/rpc" && request.method === "POST") {
      void readBody(request).then((raw) => {
        const envelope = JSON.parse(raw) as Record<string, unknown>;
        envelopes.push(envelope);
        sendJson(response, 200, { id: envelope.id, ok: true, result: { tabs: [] } });
      });
      return;
    }
    sendJson(response, 404, { ok: false });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  check(address && typeof address === "object", "expected a bound stub daemon address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    envelopes,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function currentHealth() {
  return { ok: true, protocolVersion: PROTOCOL_VERSION, profileCount: 1 };
}

function clientFor(daemonUrl: string, authToken: string, options: ClientOptions = {}) {
  return new DaemonClient({ daemonUrl, authToken, ...options });
}

async function thrownBy(action: () => Promise<unknown>, what = "the call"): Promise<Error> {
  try {
    await action();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error(`expected ${what} to fail, but it succeeded`);
}

function tabTitles(result: unknown): string[] {
  return (result as { tabs: Array<{ title: string }> }).tabs.map((tab) => tab.title);
}

function profileNicknames(result: unknown): string[] {
  return (result as { profiles: Array<{ nickname: string }> }).profiles.map((profile) => profile.nickname);
}

function mentions(text: string, nickname: string): boolean {
  return text.toLowerCase().includes(nickname.toLowerCase());
}

const schemaScenarios: Scenario[] = [
  [
    "every browser tool schema has an optional profile and list_profiles has none",
    async () => {
      const definitions = new Map<string, { inputSchema: unknown }>(
        getToolDefinitions().map((tool) => [tool.name, tool]),
      );
      check(toolCatalog.length === 48, `expected 48 catalog tools, found ${toolCatalog.length}`);
      const missing = toolCatalog
        .map((tool) => tool.name)
        .filter((name) => {
          const schema = definitions.get(name)?.inputSchema as
            | { properties?: Record<string, unknown>; required?: string[] }
            | undefined;
          return !schema?.properties?.profile || (schema.required ?? []).includes("profile");
        });
      check(missing.length === 0, `tools without an optional profile input: ${missing.join(", ")}`);
      const listProfiles = definitions.get("list_profiles");
      check(listProfiles, "list_profiles is not offered");
      const listSchema = listProfiles.inputSchema as { type?: unknown; properties?: Record<string, unknown> };
      check(listSchema.type === "object", "list_profiles input schema is not an object");
      check(!listSchema.properties?.profile, "list_profiles must not take a profile input");
    },
  ],
];

const envelopeScenarios: Scenario[] = [
  [
    "profile is taken out of the tool input and sent in the envelope",
    async () => {
      const stub = await startStubDaemon(currentHealth());
      try {
        await handleToolCall(clientFor(stub.url, "stub-token"), "list_tabs", { profile: ALPHA });
        const envelope = stub.envelopes[0];
        check(envelope, "the stub daemon received no request");
        check(envelope.profile === ALPHA, `envelope profile is ${JSON.stringify(envelope.profile)}`);
        const params = envelope.params as Record<string, unknown>;
        check(!("profile" in params), "profile was passed on to the tool parameters");
      } finally {
        await stub.close();
      }
    },
  ],
  [
    "under the lock another profile is refused before any daemon call, naming only the locked one",
    async () => {
      const stub = await startStubDaemon(currentHealth());
      try {
        const client = clientFor(stub.url, "stub-token", { defaultProfile: ALPHA, profileLocked: true });
        const received = () => stub.envelopes.length;
        const error = await thrownBy(() => handleToolCall(client, "list_tabs", { profile: BRAVO }));
        check(received() === 0, `the daemon received ${received()} request(s)`);
        check(mentions(error.message, ALPHA), `refusal does not name the locked profile: ${error.message}`);
        check(!mentions(error.message, BRAVO), `refusal names another profile: ${error.message}`);
        await handleToolCall(client, "list_tabs", { profile: ALPHA.toLowerCase() });
        check(received() === 1, "the locked profile in other letter case was refused");
      } finally {
        await stub.close();
      }
    },
  ],
];

const routingScenarios: Scenario[] = [
  [
    "a named call does not make the next unnamed call go to that profile",
    async (env) => {
      const client = clientFor(env.daemonUrl, env.secret);
      const bravoBefore = env.bravo.receivedRequestCount;
      const named = await handleToolCall(client, "list_tabs", { profile: ALPHA });
      check(tabTitles(named).includes("Alpha Tab"), `named call returned ${JSON.stringify(named)}`);
      check(env.bravo.receivedRequestCount === bravoBefore, "a call naming Alpha reached Bravo");
      const error = await thrownBy(() => handleToolCall(client, "list_tabs", {}));
      check(
        mentions(error.message, ALPHA) && mentions(error.message, BRAVO),
        `unnamed refusal does not list the connected profiles: ${error.message}`,
      );
    },
  ],
  [
    "client errors carry the daemon code and details",
    async (env) => {
      const client = clientFor(env.daemonUrl, env.secret);
      const required = await thrownBy(() => client.call("tabs.list", {}));
      check(required instanceof DaemonCallError, `unnamed call threw ${required.name}: ${required.message}`);
      check(required.code === "BRAVE_PROFILE_REQUIRED", `unnamed call code is ${required.code}`);
      const connected = (required.details?.connected ?? []) as string[];
      check(connected.includes(ALPHA) && connected.includes(BRAVO), `details: ${JSON.stringify(required.details)}`);
      const notFound = await thrownBy(() => client.withProfile(ABSENT).call("tabs.list", {}));
      check(notFound instanceof DaemonCallError, `unknown profile threw ${notFound.name}: ${notFound.message}`);
      check(notFound.code === "BRAVE_PROFILE_NOT_FOUND", `unknown profile code is ${notFound.code}`);
    },
  ],
  [
    "the default profile is used for unnamed calls",
    async (env) => {
      const client = clientFor(env.daemonUrl, env.secret, { defaultProfile: ALPHA });
      const bravoBefore = env.bravo.receivedRequestCount;
      const result = await handleToolCall(client, "list_tabs", {});
      check(tabTitles(result).includes("Alpha Tab"), `unnamed call returned ${JSON.stringify(result)}`);
      check(env.bravo.receivedRequestCount === bravoBefore, "an unnamed call with default Alpha reached Bravo");
    },
  ],
  [
    "without the lock a named other profile works",
    async (env) => {
      const client = clientFor(env.daemonUrl, env.secret, { defaultProfile: ALPHA });
      const result = await handleToolCall(client, "list_tabs", { profile: BRAVO });
      check(tabTitles(result).includes("Bravo Tab"), `call naming Bravo returned ${JSON.stringify(result)}`);
    },
  ],
  [
    "list_profiles returns the connected nicknames",
    async (env) => {
      const result = await handleToolCall(clientFor(env.daemonUrl, env.secret), "list_profiles", {});
      const nicknames = profileNicknames(result);
      check(nicknames.includes(ALPHA) && nicknames.includes(BRAVO), `list_profiles returned ${nicknames}`);
    },
  ],
  [
    "under the lock list_profiles shows only the locked profile",
    async (env) => {
      const client = clientFor(env.daemonUrl, env.secret, { defaultProfile: ALPHA, profileLocked: true });
      const nicknames = profileNicknames(await handleToolCall(client, "list_profiles", {}));
      check(nicknames.length === 1 && nicknames[0] === ALPHA, `list_profiles returned ${nicknames}`);
    },
  ],
  [
    "a default that is not connected is reported offline by name, without a list",
    async (env) => {
      const client = clientFor(env.daemonUrl, env.secret, { defaultProfile: ABSENT });
      const error = await thrownBy(() => handleToolCall(client, "list_tabs", {}));
      check(mentions(error.message, ABSENT), `message does not name the default: ${error.message}`);
      check(/offline/i.test(error.message), `message does not say offline: ${error.message}`);
      check(
        !mentions(error.message, ALPHA) && !mentions(error.message, BRAVO),
        `message lists other profiles: ${error.message}`,
      );
    },
  ],
  [
    "no message or result under the lock contains another nickname",
    async (env) => {
      const client = clientFor(env.daemonUrl, env.secret, { defaultProfile: ABSENT, profileLocked: true });
      const texts = [
        (await thrownBy(() => handleToolCall(client, "list_tabs", {}))).message,
        (await thrownBy(() => handleToolCall(client, "list_tabs", { profile: ALPHA }))).message,
        (await thrownBy(() => handleToolCall(client, "get_tab_info", { tabId: 101, profile: BRAVO }))).message,
        JSON.stringify(await handleToolCall(client, "list_profiles", {})),
      ];
      const leaks = texts.filter((text) => mentions(text, ALPHA) || mentions(text, BRAVO));
      check(leaks.length === 0, `texts naming another profile: ${leaks.join(" | ")}`);
      check(mentions(texts[0] ?? "", ABSENT), `offline message does not name the locked profile: ${texts[0]}`);
    },
  ],
];

const startScenarios: Scenario[] = [
  [
    "a lock without a default, or an invalid default, fails at start; env sets both",
    async (env) => {
      const base = { daemonUrl: env.daemonUrl, configDir: env.configDir };
      await thrownBy(() => resolveRuntimeConfig({ ...base, profileLocked: true }), "a lock without a default");
      await thrownBy(() => resolveRuntimeConfig({ ...base, defaultProfile: "-not valid!" }), "an invalid default");
      const saved = { profile: process.env.BRAVE_MCP_PROFILE, lock: process.env.BRAVE_MCP_PROFILE_LOCK };
      try {
        process.env.BRAVE_MCP_PROFILE = ALPHA;
        process.env.BRAVE_MCP_PROFILE_LOCK = "1";
        const locked = await resolveRuntimeConfig(base);
        check(locked.defaultProfile === ALPHA, `env default read as ${locked.defaultProfile}`);
        check(locked.profileLocked === true, "BRAVE_MCP_PROFILE_LOCK=1 did not lock");
        process.env.BRAVE_MCP_PROFILE_LOCK = "0";
        const unlocked = await resolveRuntimeConfig(base);
        check(unlocked.profileLocked === false, "BRAVE_MCP_PROFILE_LOCK=0 locked");
      } finally {
        restoreEnv("BRAVE_MCP_PROFILE", saved.profile);
        restoreEnv("BRAVE_MCP_PROFILE_LOCK", saved.lock);
      }
    },
  ],
  [
    "a daemon whose /healthz lacks protocolVersion is refused",
    async (env) => {
      const old = await startStubDaemon({ ok: true });
      const current = await startStubDaemon(currentHealth());
      try {
        const error = await thrownBy(() => ensureDaemonAvailable({ daemonUrl: old.url, configDir: env.configDir }));
        check(error.message.includes(old.url), `refusal does not name the daemon URL: ${error.message}`);
        check(/old/i.test(error.message), `refusal does not say the daemon is too old: ${error.message}`);
        await ensureDaemonAvailable({ daemonUrl: current.url, configDir: env.configDir });
      } finally {
        await old.close();
        await current.close();
      }
    },
  ],
];

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function runScenario([name, run]: Scenario, env: ProfileEnvironment): Promise<string | null> {
  const startedAt = Date.now();
  try {
    await Promise.race([
      run(env),
      delay(SCENARIO_TIME_LIMIT_MS).then(() => {
        throw new Error(`scenario time limit of ${SCENARIO_TIME_LIMIT_MS} ms reached`);
      }),
    ]);
    process.stderr.write(`[profiles] ok   ${name} (${Date.now() - startedAt} ms)\n`);
    return null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[profiles] FAIL ${name} (${Date.now() - startedAt} ms): ${reason}\n`);
    return `${name}: ${reason}`;
  }
}

export async function runProfileScenarios(): Promise<number> {
  const scenarios = [...schemaScenarios, ...envelopeScenarios, ...routingScenarios, ...startScenarios];
  process.stderr.write(`[profiles] starting a daemon with profiles ${ALPHA} and ${BRAVO}\n`);
  const { env, daemon } = await startEnvironment();
  const failures: string[] = [];
  try {
    for (const scenario of scenarios) {
      const failure = await runScenario(scenario, env);
      if (failure) {
        failures.push(failure);
      }
    }
  } finally {
    await env.alpha.close();
    await env.bravo.close();
    daemon.kill();
  }
  check(
    failures.length === 0,
    `Profile scenarios failed (${failures.length} of ${scenarios.length}):\n- ${failures.join("\n- ")}`,
  );
  return scenarios.length;
}

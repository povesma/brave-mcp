import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BRIDGE_CLOSE_CODES, PROTOCOL_VERSION } from "@brave-mcp/protocol";
import { connectSimulatedExtensionBridge, type SimulatedExtensionBridge } from "@brave-mcp/sdk";
import WebSocket from "ws";

import { createDaemonApp, type DaemonTimings } from "./app.js";

const SCENARIO_TIME_LIMIT_MS = 10_000;

const FAST_TIMINGS: DaemonTimings = {
  helloTimeoutMs: 300,
  pingIntervalMs: 200,
  pongTimeoutMs: 200,
  clashProbeTimeoutMs: 200,
  refusalLogIntervalMs: 60_000,
};

interface CloseEvent {
  code: number;
  reason: string;
}

interface RawBridge {
  socket: WebSocket;
  received: string[];
  closed: Promise<CloseEvent>;
  send(message: unknown): void;
}

export interface TestDaemon {
  baseUrl: string;
  wsUrl: string;
  secret: string;
  logLines: string[];
  rpc(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }>;
  raw(options?: { autoPong?: boolean }): Promise<RawBridge>;
  simulated(profile: string, installationId?: string, tabIds?: number[]): Promise<SimulatedExtensionBridge>;
  close(): Promise<void>;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await delay(20);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

async function closeWithin(bridge: RawBridge, timeoutMs: number): Promise<CloseEvent | null> {
  return Promise.race([bridge.closed, delay(timeoutMs).then(() => null)]);
}

function hello(profile: string | undefined, installationId: string | undefined = randomUUID()) {
  return {
    type: "hello",
    browser: "brave",
    version: "0.0.2",
    profile,
    installationId,
    protocolVersion: PROTOCOL_VERSION,
  };
}

export async function startTestDaemon(timings: Partial<DaemonTimings> = {}): Promise<TestDaemon> {
  const configDir = await mkdtemp(join(tmpdir(), "brave-mcp-daemon-profiles-"));
  const logLines: string[] = [];
  const { app, state } = await createDaemonApp({
    configDir,
    logStream: { write: (line) => logLines.push(line) },
    timings: { ...FAST_TIMINGS, ...timings },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  check(address && typeof address === "object", "expected a bound server address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}/extension/connect`;
  const secret = state.config.secret;
  const rawBridges: RawBridge[] = [];
  const simulatedBridges: SimulatedExtensionBridge[] = [];

  return {
    baseUrl,
    wsUrl,
    secret,
    logLines,
    async rpc(body) {
      const response = await fetch(`${baseUrl}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: randomUUID(), params: {}, authToken: secret, ...body }),
        signal: AbortSignal.timeout(SCENARIO_TIME_LIMIT_MS),
      });
      return { status: response.status, json: (await response.json()) as Record<string, unknown> };
    },
    async raw(options = {}) {
      const socket = new WebSocket(`${wsUrl}?authToken=${encodeURIComponent(secret)}`, {
        autoPong: options.autoPong ?? true,
      });
      const received: string[] = [];
      socket.on("message", (data) => received.push(data.toString()));
      const closed = new Promise<CloseEvent>((resolve) => {
        socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });
      const bridge: RawBridge = {
        socket,
        received,
        closed,
        send: (message) => socket.send(JSON.stringify(message)),
      };
      rawBridges.push(bridge);
      return bridge;
    },
    async simulated(profile, installationId, tabIds = [11]) {
      const bridge = await connectSimulatedExtensionBridge({
        daemonUrl: wsUrl,
        authToken: secret,
        profile,
        ...(installationId ? { installationId } : {}),
        tabs: tabIds.map((tabId, index) => ({
          tabId,
          windowId: 1,
          title: `${profile} tab ${tabId}`,
          url: `https://example.test/${encodeURIComponent(profile)}/${tabId}`,
          active: index === 0,
        })),
      });
      simulatedBridges.push(bridge);
      return bridge;
    },
    async close() {
      for (const bridge of rawBridges) {
        bridge.socket.terminate();
      }
      await Promise.all(simulatedBridges.map((bridge) => Promise.race([bridge.close(), delay(500)])));
      await app.close();
    },
  };
}

async function isPaired(daemon: TestDaemon): Promise<boolean> {
  const response = await fetch(`${daemon.baseUrl}/readyz`);
  const json = (await response.json()) as { paired?: boolean };
  return json.paired === true;
}

type Scenario = [string, (daemon: TestDaemon) => Promise<void>];

const registryScenarios: Scenario[] = [
  [
    "two profiles stay connected at once",
    async (daemon) => {
      const alpha = await daemon.raw();
      alpha.send(hello("Alpha"));
      const beta = await daemon.raw();
      beta.send(hello("Beta"));
      const [alphaClose, betaClose] = await Promise.all([
        closeWithin(alpha, FAST_TIMINGS.helloTimeoutMs * 3),
        closeWithin(beta, FAST_TIMINGS.helloTimeoutMs * 3),
      ]);
      check(alphaClose === null, `Alpha was closed (code ${alphaClose?.code})`);
      check(betaClose === null, `Beta was closed (code ${betaClose?.code})`);
    },
  ],
  [
    "an unnamed socket receives no requests",
    async (daemon) => {
      const alpha = await daemon.simulated("Alpha");
      await waitUntil(() => isPaired(daemon), 2_000, "Alpha to register");
      const unnamed = await daemon.raw();
      const { json } = await daemon.rpc({ method: "tabs.list" });
      check(json.ok === true, `tabs.list failed: ${JSON.stringify(json)}`);
      check(alpha.receivedRequestCount === 1, `Alpha received ${alpha.receivedRequestCount} requests`);
      check(unnamed.received.length === 0, `the unnamed socket received ${unnamed.received.length} messages`);
    },
  ],
  [
    "a second hello closes the socket with 4400",
    async (daemon) => {
      const bridge = await daemon.raw();
      const installationId = randomUUID();
      bridge.send(hello("Alpha", installationId));
      await delay(50);
      bridge.send(hello("Alpha", installationId));
      const closed = await closeWithin(bridge, 2_000);
      check(closed?.code === BRIDGE_CLOSE_CODES.invalidHello, `closed with ${closed?.code}`);
    },
  ],
  [
    "a first message other than hello closes the socket with 4400",
    async (daemon) => {
      const bridge = await daemon.raw();
      bridge.send({ type: "ping", sentAt: new Date().toISOString() });
      const closed = await closeWithin(bridge, 2_000);
      check(closed?.code === BRIDGE_CLOSE_CODES.invalidHello, `closed with ${closed?.code}`);
    },
  ],
  [
    "an invalid nickname gets 4400",
    async (daemon) => {
      const bridge = await daemon.raw();
      bridge.send(hello("-bad"));
      const closed = await closeWithin(bridge, 2_000);
      check(closed?.code === BRIDGE_CLOSE_CODES.invalidHello, `closed with ${closed?.code}`);
    },
  ],
  [
    "a hello without an installation id gets 4400",
    async (daemon) => {
      const bridge = await daemon.raw();
      const { installationId: _omitted, ...withoutInstallationId } = hello("Alpha");
      bridge.send(withoutInstallationId);
      const closed = await closeWithin(bridge, 2_000);
      check(closed?.code === BRIDGE_CLOSE_CODES.invalidHello, `closed with ${closed?.code}`);
    },
  ],
  [
    "no hello in time gets 4408",
    async (daemon) => {
      const bridge = await daemon.raw();
      const closed = await closeWithin(bridge, FAST_TIMINGS.helloTimeoutMs + 1_000);
      check(closed?.code === BRIDGE_CLOSE_CODES.helloTimeout, `closed with ${closed?.code}`);
    },
  ],
  [
    "a 0.0.1 hello gets 4426",
    async (daemon) => {
      const bridge = await daemon.raw();
      bridge.send({ type: "hello", browser: "brave", version: "0.0.1" });
      const closed = await closeWithin(bridge, 2_000);
      check(closed?.code === BRIDGE_CLOSE_CODES.extensionTooOld, `closed with ${closed?.code}`);
    },
  ],
];

const replaceScenarios: Scenario[] = [
  [
    "a restart with the same installation id replaces the old socket with 4000",
    async (daemon) => {
      const installationId = randomUUID();
      const old = await daemon.raw();
      old.send(hello("Alpha", installationId));
      await waitUntil(() => isPaired(daemon), 2_000, "the first Alpha socket to register");
      const restarted = await daemon.simulated("Alpha", installationId);
      const closed = await closeWithin(old, 2_000);
      check(closed?.code === BRIDGE_CLOSE_CODES.replaced, `old socket closed with ${closed?.code}`);
      const { json } = await daemon.rpc({ method: "tabs.list", profile: "Alpha" });
      check(json.ok === true, `tabs.list failed: ${JSON.stringify(json)}`);
      check(restarted.receivedRequestCount === 1, `restarted socket got ${restarted.receivedRequestCount}`);
      check(old.received.length === 0, `old socket got ${old.received.length} messages`);
    },
  ],
  [
    "a rename under the same installation id moves the entry",
    async (daemon) => {
      const installationId = randomUUID();
      const old = await daemon.raw();
      old.send(hello("Alpha", installationId));
      await waitUntil(() => isPaired(daemon), 2_000, "Alpha to register");
      const renamed = await daemon.simulated("Work", installationId);
      const closed = await closeWithin(old, 2_000);
      check(closed?.code === BRIDGE_CLOSE_CODES.replaced, `old socket closed with ${closed?.code}`);
      const work = await daemon.rpc({ method: "tabs.list", profile: "Work" });
      check(work.json.ok === true, `tabs.list on Work failed: ${JSON.stringify(work.json)}`);
      const alpha = await daemon.rpc({ method: "tabs.list", profile: "Alpha" });
      check(alpha.json.ok === false, "the old nickname Alpha still answers");
      check(renamed.receivedRequestCount === 1, `renamed socket got ${renamed.receivedRequestCount}`);
    },
  ],
  [
    "a case-only rename replaces the socket under the same key",
    async (daemon) => {
      const installationId = randomUUID();
      const old = await daemon.raw();
      old.send(hello("alpha", installationId));
      await waitUntil(() => isPaired(daemon), 2_000, "alpha to register");
      const renamed = await daemon.simulated("Alpha", installationId);
      const closed = await closeWithin(old, 2_000);
      check(closed?.code === BRIDGE_CLOSE_CODES.replaced, `old socket closed with ${closed?.code}`);
      const { json } = await daemon.rpc({ method: "tabs.list", profile: "ALPHA" });
      check(json.ok === true, `tabs.list failed: ${JSON.stringify(json)}`);
      check(renamed.receivedRequestCount === 1, `renamed socket got ${renamed.receivedRequestCount}`);
    },
  ],
];

export function requestIdAt(bridge: RawBridge, index: number): string {
  const message = JSON.parse(bridge.received[index] ?? "{}") as { id?: string };
  check(typeof message.id === "string", `no request at index ${index}`);
  return message.id;
}

function respondTabs(bridge: RawBridge, id: string, title: string): void {
  bridge.send({
    type: "response",
    id,
    ok: true,
    result: { tabs: [{ tabId: 1, windowId: 1, title, url: "https://example.test/", active: true }] },
  });
}

const REGISTRATION_PAUSE_MS = 100;

export async function registeredRaw(daemon: TestDaemon, nickname: string, installationId = randomUUID()) {
  const bridge = await daemon.raw();
  bridge.send(hello(nickname, installationId));
  await delay(REGISTRATION_PAUSE_MS);
  return bridge;
}

function checkOfflineFor(json: Record<string, unknown>, nickname: string): void {
  const error = json.error as { code?: string; message?: string; details?: { profile?: string } } | undefined;
  check(json.ok === false && error?.code === "BRAVE_EXTENSION_OFFLINE", `expected offline, got ${JSON.stringify(json)}`);
  check(error.details?.profile === nickname, `details.profile is ${error.details?.profile}`);
  check(/may already have run/.test(error.message ?? ""), `message lacks the may-have-run warning: ${error.message}`);
  check(!(error.message ?? "").includes(nickname), "the error message contains the nickname");
}

const waitingScenarios: Scenario[] = [
  [
    "closing profile A ends only A's waiting requests",
    async (daemon) => {
      const alpha = await registeredRaw(daemon, "Alpha");
      const beta = await registeredRaw(daemon, "Beta");
      const alphaCall = daemon.rpc({ method: "tabs.list", profile: "Alpha" });
      const betaCall = daemon.rpc({ method: "tabs.list", profile: "Beta" });
      await waitUntil(() => alpha.received.length === 1 && beta.received.length === 1, 2_000, "both requests");
      alpha.socket.close();
      const alphaResult = await Promise.race([alphaCall, delay(2_000).then(() => null)]);
      check(alphaResult !== null, "Alpha's request did not end after Alpha closed");
      checkOfflineFor(alphaResult.json, "Alpha");
      respondTabs(beta, requestIdAt(beta, 0), "from Beta");
      const betaResult = await betaCall;
      check(betaResult.json.ok === true, `Beta's request failed: ${JSON.stringify(betaResult.json)}`);
    },
  ],
  [
    "a response from another profile's socket is dropped",
    async (daemon) => {
      const alpha = await registeredRaw(daemon, "Alpha");
      const beta = await registeredRaw(daemon, "Beta");
      const alphaCall = daemon.rpc({ method: "tabs.list", profile: "Alpha" });
      await waitUntil(() => alpha.received.length === 1, 2_000, "Alpha's request");
      const id = requestIdAt(alpha, 0);
      respondTabs(beta, id, "forged by Beta");
      await delay(100);
      respondTabs(alpha, id, "from Alpha");
      const { json } = await alphaCall;
      const tabs = (json.result as { tabs?: Array<{ title: string }> } | undefined)?.tabs;
      check(tabs?.[0]?.title === "from Alpha", `Alpha's result came from ${tabs?.[0]?.title}`);
    },
  ],
  [
    "a replacement ends only the old socket's requests",
    async (daemon) => {
      const installationId = randomUUID();
      const alpha = await registeredRaw(daemon, "Alpha", installationId);
      const beta = await registeredRaw(daemon, "Beta");
      const alphaCall = daemon.rpc({ method: "tabs.list", profile: "Alpha" });
      const betaCall = daemon.rpc({ method: "tabs.list", profile: "Beta" });
      await waitUntil(() => alpha.received.length === 1 && beta.received.length === 1, 2_000, "both requests");
      const restarted = await daemon.raw();
      restarted.send(hello("Alpha", installationId));
      const alphaResult = await Promise.race([alphaCall, delay(2_000).then(() => null)]);
      check(alphaResult !== null, "the old Alpha request did not end after the replacement");
      checkOfflineFor(alphaResult.json, "Alpha");
      respondTabs(beta, requestIdAt(beta, 0), "from Beta");
      const betaResult = await betaCall;
      check(betaResult.json.ok === true, `Beta's request failed: ${JSON.stringify(betaResult.json)}`);
    },
  ],
];

const LIVENESS_WAIT_MS = (FAST_TIMINGS.pingIntervalMs + FAST_TIMINGS.pongTimeoutMs) * 3;

const livenessScenarios: Scenario[] = [
  [
    "a nickname held by a live other installation refuses the newcomer with 4409",
    async (daemon) => {
      const holder = await registeredRaw(daemon, "Alpha");
      const newcomer = await daemon.raw();
      newcomer.send(hello("Alpha"));
      const closed = await closeWithin(newcomer, FAST_TIMINGS.clashProbeTimeoutMs + 1_000);
      check(closed?.code === BRIDGE_CLOSE_CODES.nicknameInUse, `newcomer closed with ${closed?.code}`);
      check((await closeWithin(holder, 300)) === null, "the live holder was closed");
    },
  ],
  [
    "a holder that stops answering pings is evicted and the newcomer registers",
    async (daemon) => {
      const holder = await daemon.raw({ autoPong: false });
      holder.send(hello("Alpha"));
      await delay(REGISTRATION_PAUSE_MS);
      const newcomer = await daemon.simulated("Alpha");
      const closed = await closeWithin(holder, FAST_TIMINGS.clashProbeTimeoutMs + 1_000);
      check(closed !== null, "the silent holder was not evicted");
      const { json } = await daemon.rpc({ method: "tabs.list", profile: "Alpha" });
      check(json.ok === true, `tabs.list failed: ${JSON.stringify(json)}`);
      check(newcomer.receivedRequestCount === 1, `newcomer got ${newcomer.receivedRequestCount}`);
    },
  ],
  [
    "a registered socket that answers pings stays connected",
    async (daemon) => {
      const alpha = await daemon.simulated("Alpha");
      await delay(LIVENESS_WAIT_MS);
      const { json } = await daemon.rpc({ method: "tabs.list", profile: "Alpha" });
      check(json.ok === true, `tabs.list failed after ${LIVENESS_WAIT_MS} ms: ${JSON.stringify(json)}`);
      check(alpha.receivedRequestCount === 1, `Alpha got ${alpha.receivedRequestCount}`);
    },
  ],
  [
    "a registered socket that stops answering pings is terminated",
    async (daemon) => {
      const alpha = await daemon.simulated("Alpha");
      await waitUntil(() => isPaired(daemon), 2_000, "Alpha to register");
      alpha.stopAnsweringPings();
      await waitUntil(async () => !(await isPaired(daemon)), LIVENESS_WAIT_MS, "the silent socket to be dropped");
    },
  ],
];

const loggingScenarios: Scenario[] = [
  [
    "the daemon log holds the installation id and close code but no nickname or token",
    async (daemon) => {
      const nickname = "Zephyr Logcheck";
      const installationId = randomUUID();
      const alpha = await registeredRaw(daemon, nickname, installationId);
      const call = daemon.rpc({ method: "tabs.list", profile: nickname });
      await waitUntil(() => alpha.received.length === 1, 2_000, "the request");
      respondTabs(alpha, requestIdAt(alpha, 0), nickname);
      await call;
      const clash = await daemon.raw();
      clash.send(hello(nickname));
      await closeWithin(clash, 2_000);
      alpha.socket.close();
      await alpha.closed;
      await delay(50);
      const log = daemon.logLines.join("");
      check(!log.toLowerCase().includes(nickname.toLowerCase()), "the log contains the nickname");
      check(!log.includes(daemon.secret), "the log contains the token");
      check(log.includes(installationId), "the log does not name the installation id");
      check(log.includes(String(BRIDGE_CLOSE_CODES.nicknameInUse)), "the log does not hold the 4409 close code");
    },
  ],
  [
    "repeated 0.0.1 hellos produce one refusal log line per interval",
    async (daemon) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const old = await daemon.raw();
        old.send({ type: "hello", browser: "brave", version: "0.0.1" });
        await closeWithin(old, 2_000);
      }
      await delay(50);
      const refusals = daemon.logLines.filter((line) => line.includes("older protocol"));
      check(refusals.length === 1, `found ${refusals.length} refusal log lines`);
    },
  ],
];

async function listProfiles(daemon: TestDaemon): Promise<Array<{ nickname: string; connectedAt: string }>> {
  const { json } = await daemon.rpc({ method: "profiles.list" });
  const profiles = (json.result as { profiles?: unknown } | undefined)?.profiles;
  return Array.isArray(profiles) ? (profiles as Array<{ nickname: string; connectedAt: string }>) : [];
}

async function waitForProfiles(daemon: TestDaemon, nicknames: string[]): Promise<void> {
  await waitUntil(
    async () => {
      const listed = (await listProfiles(daemon)).map((profile) => profile.nickname).sort();
      return JSON.stringify(listed) === JSON.stringify([...nicknames].sort());
    },
    2_000,
    `profiles.list to show ${nicknames.join(", ")}`,
  );
}

function errorOf(json: Record<string, unknown>) {
  return json.error as { code?: string; message?: string; details?: { connected?: unknown } } | undefined;
}

function checkProfileError(
  result: { status: number; json: Record<string, unknown> },
  code: string,
  connected: string[],
  nicknames: string[],
): void {
  const error = errorOf(result.json);
  check(result.status === 409, `status ${result.status}, expected 409`);
  check(error?.code === code, `code ${error?.code}, expected ${code}`);
  const listed = Array.isArray(error.details?.connected) ? [...(error.details.connected as string[])].sort() : null;
  check(JSON.stringify(listed) === JSON.stringify([...connected].sort()), `details.connected is ${JSON.stringify(listed)}`);
  for (const nickname of nicknames) {
    check(!(error.message ?? "").toLowerCase().includes(nickname.toLowerCase()), `message names ${nickname}`);
  }
}

async function statusBodies(daemon: TestDaemon): Promise<{ health: Record<string, unknown>; ready: Record<string, unknown> }> {
  const [health, ready] = await Promise.all([
    fetch(`${daemon.baseUrl}/healthz`).then((response) => response.json() as Promise<Record<string, unknown>>),
    fetch(`${daemon.baseUrl}/readyz`).then((response) => response.json() as Promise<Record<string, unknown>>),
  ]);
  return { health, ready };
}

const routingScenarios: Scenario[] = [
  [
    "an unnamed request runs with one profile and is offline with none",
    async (daemon) => {
      const none = await daemon.rpc({ method: "tabs.list" });
      check(none.status === 503 && errorOf(none.json)?.code === "BRAVE_EXTENSION_OFFLINE", `none: ${none.status}`);
      await daemon.simulated("Alpha");
      await waitForProfiles(daemon, ["Alpha"]);
      const one = await daemon.rpc({ method: "tabs.list" });
      check(one.json.ok === true, `one profile: ${JSON.stringify(one.json)}`);
    },
  ],
  [
    "an unnamed request with several profiles gets BRAVE_PROFILE_REQUIRED 409",
    async (daemon) => {
      const alpha = await daemon.simulated("Alpha");
      const beta = await daemon.simulated("Beta");
      await waitForProfiles(daemon, ["Alpha", "Beta"]);
      for (const method of ["tabs.list", "tabs.open", "windows.create"]) {
        const result = await daemon.rpc({ method, params: { url: "https://example.test/" } });
        checkProfileError(result, "BRAVE_PROFILE_REQUIRED", ["Alpha", "Beta"], ["Alpha", "Beta"]);
      }
      check(alpha.receivedRequestCount + beta.receivedRequestCount === 0, "an unnamed request reached a profile");
    },
  ],
  [
    "an unknown name gets BRAVE_PROFILE_NOT_FOUND 409 with the connected nicknames",
    async (daemon) => {
      await daemon.simulated("Alpha");
      await waitForProfiles(daemon, ["Alpha"]);
      const result = await daemon.rpc({ method: "tabs.list", profile: "Gamma" });
      checkProfileError(result, "BRAVE_PROFILE_NOT_FOUND", ["Alpha"], ["Alpha", "Gamma"]);
    },
  ],
  [
    "requests naming A never reach B, and a following unnamed request still fails",
    async (daemon) => {
      const alpha = await daemon.simulated("Alpha");
      const beta = await daemon.simulated("Beta");
      await waitForProfiles(daemon, ["Alpha", "Beta"]);
      for (const method of ["tabs.list", "tabs.open", "windows.create"]) {
        const result = await daemon.rpc({ method, profile: "alpha", params: { url: "https://example.test/" } });
        check(result.json.ok === true, `${method} on Alpha failed: ${JSON.stringify(result.json)}`);
      }
      check(alpha.receivedRequestCount === 3, `Alpha got ${alpha.receivedRequestCount}`);
      check(beta.receivedRequestCount === 0, `Beta got ${beta.receivedRequestCount}`);
      const unnamed = await daemon.rpc({ method: "tabs.list" });
      checkProfileError(unnamed, "BRAVE_PROFILE_REQUIRED", ["Alpha", "Beta"], ["Alpha", "Beta"]);
    },
  ],
  [
    "a tab id that only A has, named with B, fails as BRAVE_TAB_NOT_FOUND",
    async (daemon) => {
      await daemon.simulated("Alpha", undefined, [101]);
      await daemon.simulated("Beta", undefined, [202]);
      await waitForProfiles(daemon, ["Alpha", "Beta"]);
      const onAlpha = await daemon.rpc({ method: "tabs.getInfo", profile: "Alpha", params: { tabId: 101 } });
      check(onAlpha.json.ok === true, `tab 101 on Alpha failed: ${JSON.stringify(onAlpha.json)}`);
      const onBeta = await daemon.rpc({ method: "tabs.getInfo", profile: "Beta", params: { tabId: 101 } });
      check(errorOf(onBeta.json)?.code === "BRAVE_TAB_NOT_FOUND", `tab 101 on Beta: ${JSON.stringify(onBeta.json)}`);
    },
  ],
  [
    "profiles.list needs the secret and keeps the latest spelling of a nickname",
    async (daemon) => {
      const installationId = randomUUID();
      await daemon.simulated("alpha", installationId);
      await waitForProfiles(daemon, ["alpha"]);
      await daemon.simulated("Alpha", installationId);
      await waitForProfiles(daemon, ["Alpha"]);
      const [profile] = await listProfiles(daemon);
      check(typeof profile?.connectedAt === "string", "profiles.list has no connectedAt");
      const denied = await daemon.rpc({ method: "profiles.list", authToken: "wrong-secret" });
      check(denied.status === 401, `profiles.list without the secret returned ${denied.status}`);
    },
  ],
  [
    "status bodies carry protocolVersion and profileCount and no nickname",
    async (daemon) => {
      await daemon.simulated("Zephyr Status");
      await daemon.simulated("Beta");
      await waitForProfiles(daemon, ["Zephyr Status", "Beta"]);
      const { health, ready } = await statusBodies(daemon);
      check(health.protocolVersion === PROTOCOL_VERSION, `healthz protocolVersion ${health.protocolVersion}`);
      check(health.profileCount === 2 && ready.profileCount === 2, "profileCount is not 2");
      check(health.extensionConnected === true && ready.extensionConnected === true, "extensionConnected is not true");
      check(ready.paired === true && typeof ready.configDir === "string", "readyz lost paired or configDir");
      const bodies = JSON.stringify([health, ready]).toLowerCase();
      check(!bodies.includes("zephyr") && !bodies.includes("beta"), "a status body names a profile");
    },
  ],
];

async function runScenario([name, run]: Scenario): Promise<string | null> {
  const startedAt = Date.now();
  const daemon = await startTestDaemon();
  try {
    await Promise.race([
      run(daemon),
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
  } finally {
    await daemon.close();
  }
}

export async function runProfileScenarios(): Promise<number> {
  const scenarios = [
    ...registryScenarios,
    ...replaceScenarios,
    ...waitingScenarios,
    ...livenessScenarios,
    ...loggingScenarios,
    ...routingScenarios,
  ];
  const failures: string[] = [];
  for (const scenario of scenarios) {
    const failure = await runScenario(scenario);
    if (failure) {
      failures.push(failure);
    }
  }
  check(
    failures.length === 0,
    `Profile scenarios failed (${failures.length} of ${scenarios.length}):\n- ${failures.join("\n- ")}`,
  );
  return scenarios.length;
}

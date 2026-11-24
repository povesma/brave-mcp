import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import {
  BRIDGE_CLOSE_CODES,
  bridgeClientMessageSchema,
  bridgeHelloMessageSchema,
  bridgeRequestMessageSchema,
  daemonRequestSchema,
  daemonResponseSchema,
  PROTOCOL_VERSION,
  profileKey,
  toolCatalog,
  type DaemonMethod,
  type DaemonResponse,
} from "@brave-mcp/protocol";
import { WebSocketServer, type WebSocket } from "ws";

import { loadOrCreateConfig, resolveConfigDir, type DaemonConfig } from "./config.js";

export interface RuntimeState {
  configDir: string;
  config: DaemonConfig;
  extensionConnected: boolean;
  paired: boolean;
  startedAt: string;
}

export interface DaemonTimings {
  helloTimeoutMs: number;
  pingIntervalMs: number;
  pongTimeoutMs: number;
  clashProbeTimeoutMs: number;
  refusalLogIntervalMs: number;
}

export const DEFAULT_DAEMON_TIMINGS: DaemonTimings = {
  helloTimeoutMs: 5_000,
  pingIntervalMs: 20_000,
  pongTimeoutMs: 10_000,
  clashProbeTimeoutMs: 2_000,
  refusalLogIntervalMs: 60_000,
};

export interface DaemonLogStream {
  write(line: string): void;
}

export interface CreateDaemonAppOptions {
  configDir?: string;
  logger?: boolean;
  logStream?: DaemonLogStream;
  timings?: Partial<DaemonTimings>;
}

interface ProfileEntry {
  key: string;
  nickname: string;
  installationId: string;
  socket: WebSocket;
  connectedAt: string;
  livenessCheckInFlight: boolean;
}

type SocketPhase = "unnamed" | "registered" | "replaced" | "evicted";

interface SocketRecord {
  phase: SocketPhase;
  helloTimer: NodeJS.Timeout | null;
  helloReceived: boolean;
  installationId: string | null;
  entry: ProfileEntry | null;
}

function pingAndWait(socket: WebSocket, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (socket.readyState !== socket.OPEN) {
      resolve(false);
      return;
    }

    const onPong = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      socket.off("pong", onPong);
      resolve(false);
    }, timeoutMs);
    timer.unref();
    socket.once("pong", onPong);
    socket.ping();
  });
}

const CLOSE_REASONS = {
  replaced: "replaced",
  invalidHello: "invalid hello",
  helloTimeout: "no hello in time",
  nicknameInUse: "nickname in use",
  extensionTooOld: "extension too old",
} as const satisfies Record<keyof typeof BRIDGE_CLOSE_CODES, string>;

const ENDED_WHILE_WAITING_MESSAGE =
  "The extension connection ended while this request was waiting; the action may already have run.";

function offlineResponse(id: string, message: string, details?: Record<string, unknown>): DaemonResponse {
  return {
    id,
    ok: false,
    error: {
      code: "BRAVE_EXTENSION_OFFLINE",
      message,
      retryable: true,
      ...(details ? { details } : {}),
    },
  };
}

export async function createDaemonApp(
  options: CreateDaemonAppOptions = {},
): Promise<{ app: FastifyInstance; state: RuntimeState }> {
  const configDir = resolveConfigDir(options.configDir);
  const config = await loadOrCreateConfig(configDir);
  const timings: DaemonTimings = { ...DEFAULT_DAEMON_TIMINGS, ...options.timings };
  const state: RuntimeState = {
    configDir,
    config,
    extensionConnected: false,
    paired: false,
    startedAt: new Date().toISOString(),
  };

  const app = Fastify({
    logger: options.logStream ? { stream: options.logStream } : (options.logger ?? true),
  });
  const pendingRequests = new Map<
    string,
    {
      resolve: (response: DaemonResponse) => void;
      timeout: NodeJS.Timeout;
      entry: ProfileEntry;
    }
  >();
  const bridgeServer = new WebSocketServer({
    noServer: true,
  });
  const registry = new Map<string, ProfileEntry>();
  const sockets = new Map<WebSocket, SocketRecord>();

  function updateConnectionState(): void {
    const connected = registry.size > 0;
    state.extensionConnected = connected;
    state.paired = connected;
  }

  function endPendingRequestsOf(entry: ProfileEntry): void {
    for (const [id, pending] of pendingRequests) {
      if (pending.entry !== entry) {
        continue;
      }
      clearTimeout(pending.timeout);
      pendingRequests.delete(id);
      pending.resolve(offlineResponse(id, ENDED_WHILE_WAITING_MESSAGE, { profile: entry.nickname }));
    }
  }

  let lastOldProtocolLogAt = Number.NEGATIVE_INFINITY;

  function closeSocket(socket: WebSocket, reason: keyof typeof BRIDGE_CLOSE_CODES): void {
    const closeCode = BRIDGE_CLOSE_CODES[reason];
    if (reason === "extensionTooOld") {
      const now = Date.now();
      if (now - lastOldProtocolLogAt >= timings.refusalLogIntervalMs) {
        lastOldProtocolLogAt = now;
        app.log.warn(
          { closeCode },
          "refused an extension that uses an older protocol; update the extension (logged once per interval)",
        );
      }
    } else {
      const installationId = sockets.get(socket)?.installationId ?? null;
      app.log.info({ installationId, closeCode }, `daemon closed an extension connection: ${CLOSE_REASONS[reason]}`);
    }
    socket.close(closeCode, CLOSE_REASONS[reason]);
  }

  function replaceEntry(entry: ProfileEntry): void {
    registry.delete(entry.key);
    const oldRecord = sockets.get(entry.socket);
    if (oldRecord) {
      oldRecord.phase = "replaced";
    }
    closeSocket(entry.socket, "replaced");
    endPendingRequestsOf(entry);
    updateConnectionState();
  }

  function evictEntry(entry: ProfileEntry): void {
    if (registry.get(entry.key) === entry) {
      registry.delete(entry.key);
    }
    const record = sockets.get(entry.socket);
    if (record) {
      record.phase = "evicted";
    }
    endPendingRequestsOf(entry);
    entry.socket.terminate();
    updateConnectionState();
  }

  function addEntry(socket: WebSocket, record: SocketRecord, key: string, nickname: string, installationId: string) {
    const entry: ProfileEntry = {
      key,
      nickname,
      installationId,
      socket,
      connectedAt: new Date().toISOString(),
      livenessCheckInFlight: false,
    };
    registry.set(key, entry);
    record.phase = "registered";
    record.entry = entry;
    updateConnectionState();
    app.log.info({ installationId, profileCount: registry.size }, "extension profile registered");
  }

  async function register(
    socket: WebSocket,
    record: SocketRecord,
    nickname: string,
    installationId: string,
  ): Promise<void> {
    const key = profileKey(nickname);
    for (const entry of registry.values()) {
      if (entry.installationId === installationId) {
        replaceEntry(entry);
        break;
      }
    }

    const incumbent = registry.get(key);
    if (incumbent) {
      const incumbentAlive = await pingAndWait(incumbent.socket, timings.clashProbeTimeoutMs);
      if (socket.readyState !== socket.OPEN) {
        return;
      }
      if (incumbentAlive && registry.get(key) === incumbent) {
        closeSocket(socket, "nicknameInUse");
        return;
      }
      evictEntry(incumbent);
      if (registry.has(key)) {
        closeSocket(socket, "nicknameInUse");
        return;
      }
    }

    addEntry(socket, record, key, nickname, installationId);
  }

  function checkLiveness(): void {
    for (const entry of registry.values()) {
      if (entry.livenessCheckInFlight) {
        continue;
      }
      entry.livenessCheckInFlight = true;
      void pingAndWait(entry.socket, timings.pongTimeoutMs).then((alive) => {
        entry.livenessCheckInFlight = false;
        if (!alive && registry.get(entry.key) === entry) {
          evictEntry(entry);
        }
      });
    }
  }

  const livenessTimer = setInterval(checkLiveness, timings.pingIntervalMs);
  livenessTimer.unref();

  function handleFirstMessage(socket: WebSocket, record: SocketRecord, payload: unknown): void {
    if (record.helloReceived) {
      closeSocket(socket, "invalidHello");
      return;
    }
    record.helloReceived = true;
    if (record.helloTimer) {
      clearTimeout(record.helloTimer);
      record.helloTimer = null;
    }

    const parsed = bridgeHelloMessageSchema.safeParse(payload);
    if (!parsed.success) {
      closeSocket(socket, "invalidHello");
      return;
    }

    const hello = parsed.data;
    if (hello.protocolVersion === undefined || hello.protocolVersion < PROTOCOL_VERSION) {
      closeSocket(socket, "extensionTooOld");
      return;
    }

    record.installationId = hello.installationId ?? null;
    if (!hello.profile || !hello.installationId) {
      closeSocket(socket, "invalidHello");
      return;
    }

    register(socket, record, hello.profile, hello.installationId).catch((error: unknown) => {
      app.log.error(error);
      closeSocket(socket, "invalidHello");
    });
  }

  function handleRegisteredMessage(socket: WebSocket, payload: unknown): void {
    const message = bridgeClientMessageSchema.parse(payload);
    if (message.type === "hello") {
      closeSocket(socket, "invalidHello");
      return;
    }

    if (message.type === "ping") {
      return;
    }

    const pending = pendingRequests.get(message.id);
    if (!pending || pending.entry.socket !== socket) {
      return;
    }

    clearTimeout(pending.timeout);
    pendingRequests.delete(message.id);
    pending.resolve(daemonResponseSchema.parse(message));
  }

  function connectedNicknames(): string[] {
    return [...registry.values()].map((entry) => entry.nickname);
  }

  function profileError(
    id: string,
    code: "BRAVE_PROFILE_REQUIRED" | "BRAVE_PROFILE_NOT_FOUND",
    message: string,
  ): DaemonResponse {
    return {
      id,
      ok: false,
      error: {
        code,
        message,
        retryable: false,
        details: { connected: connectedNicknames() },
      },
    };
  }

  function resolveTarget(id: string, profile: string | undefined): ProfileEntry | DaemonResponse {
    if (profile !== undefined) {
      return (
        registry.get(profileKey(profile)) ??
        profileError(id, "BRAVE_PROFILE_NOT_FOUND", "No connected profile has that nickname; name a connected profile.")
      );
    }

    if (registry.size === 1) {
      const [only] = registry.values();
      if (only) {
        return only;
      }
    }

    if (registry.size === 0) {
      return offlineResponse(id, "No extension bridge is currently connected.");
    }

    return profileError(id, "BRAVE_PROFILE_REQUIRED", "Several profiles are connected; name the profile to use.");
  }

  async function callExtension(
    target: ProfileEntry,
    method: DaemonMethod,
    params: Record<string, unknown>,
  ): Promise<DaemonResponse> {
    if (target.socket.readyState !== target.socket.OPEN) {
      return offlineResponse(randomUUID(), "No extension bridge is currently connected.");
    }

    const id = randomUUID();
    const message = bridgeRequestMessageSchema.parse({
      type: "request",
      id,
      method,
      params,
    });
    const requestTimeoutMs =
      typeof params.timeoutMs === "number"
        ? Math.max(5_000, params.timeoutMs + 500)
        : 5_000;

    return new Promise<DaemonResponse>((resolve) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        resolve({
          id,
          ok: false,
          error: {
            code: "BRAVE_TIMEOUT",
            message: `Timed out waiting for extension method ${method}.`,
            retryable: true,
          },
        });
      }, requestTimeoutMs);

      pendingRequests.set(id, { resolve, timeout, entry: target });
      target.socket.send(JSON.stringify(message));
    });
  }

  app.server.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== "/extension/connect") {
      socket.destroy();
      return;
    }

    if (requestUrl.searchParams.get("authToken") !== state.config.secret) {
      socket.destroy();
      return;
    }

    bridgeServer.handleUpgrade(request, socket, head, (ws) => {
      bridgeServer.emit("connection", ws, request);
    });
  });

  bridgeServer.on("connection", (socket: WebSocket) => {
    const record: SocketRecord = {
      phase: "unnamed",
      helloTimer: null,
      helloReceived: false,
      installationId: null,
      entry: null,
    };
    sockets.set(socket, record);
    record.helloTimer = setTimeout(() => {
      record.helloTimer = null;
      if (record.phase === "unnamed" && socket.readyState === socket.OPEN) {
        closeSocket(socket, "helloTimeout");
      }
    }, timings.helloTimeoutMs);

    socket.on("message", (raw) => {
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        if (record.phase === "unnamed") {
          closeSocket(socket, "invalidHello");
        }
        return;
      }

      try {
        if (record.phase === "unnamed") {
          handleFirstMessage(socket, record, payload);
        } else if (record.phase === "registered") {
          handleRegisteredMessage(socket, payload);
        }
      } catch (error) {
        app.log.error(error);
      }
    });

    socket.on("close", (closeCode) => {
      if (record.helloTimer) {
        clearTimeout(record.helloTimer);
        record.helloTimer = null;
      }
      sockets.delete(socket);

      const entry = record.entry;
      if (entry) {
        app.log.info(
          { installationId: entry.installationId, closeCode, phase: record.phase },
          "extension connection closed",
        );
      }
      if (record.phase === "registered" && entry && registry.get(entry.key)?.socket === socket) {
        registry.delete(entry.key);
        updateConnectionState();
        endPendingRequestsOf(entry);
      }
    });
  });

  app.addHook("onClose", async () => {
    clearInterval(livenessTimer);
    for (const [socket, record] of sockets) {
      if (record.helloTimer) {
        clearTimeout(record.helloTimer);
      }
      socket.terminate();
    }
    sockets.clear();
    bridgeServer.close();
  });

  app.get("/healthz", async () => {
    return {
      ok: true,
      service: "brave-mcp-daemon",
      version: "0.0.1",
      startedAt: state.startedAt,
      toolCount: toolCatalog.length,
      protocolVersion: PROTOCOL_VERSION,
      profileCount: registry.size,
      extensionConnected: state.extensionConnected,
    };
  });

  app.get("/readyz", async (_, reply) => {
    reply.code(200);
    return {
      ok: true,
      ready: true,
      extensionConnected: state.extensionConnected,
      paired: state.paired,
      profileCount: registry.size,
      configDir: state.configDir,
    };
  });

  app.post("/rpc", async (request, reply) => {
    const parsed = daemonRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        id: "invalid",
        ok: false,
        error: {
          code: "BRAVE_INTERNAL_ERROR",
          message: "Invalid daemon request payload.",
          retryable: false,
          details: {
            issues: parsed.error.issues,
          },
        },
      } satisfies DaemonResponse;
    }

    if (parsed.data.authToken !== state.config.secret) {
      reply.code(401);
      return {
        id: parsed.data.id,
        ok: false,
        error: {
          code: "BRAVE_AUTH_REQUIRED",
          message: "Invalid daemon auth token.",
          retryable: false,
        },
      } satisfies DaemonResponse;
    }

    if (parsed.data.method === "profiles.list") {
      return {
        id: parsed.data.id,
        ok: true,
        result: {
          profiles: [...registry.values()].map((entry) => ({
            nickname: entry.nickname,
            connectedAt: entry.connectedAt,
          })),
        },
      } satisfies DaemonResponse;
    }

    const target = resolveTarget(parsed.data.id, parsed.data.profile);
    const response =
      "socket" in target ? await callExtension(target, parsed.data.method, parsed.data.params) : target;
    if (!response.ok) {
      reply.code(
        response.error.code === "BRAVE_TIMEOUT"
          ? 504
          : response.error.code === "BRAVE_AUTH_REQUIRED"
            ? 401
            : response.error.code === "BRAVE_PROFILE_REQUIRED" || response.error.code === "BRAVE_PROFILE_NOT_FOUND"
              ? 409
              : 503,
      );
    }

    return daemonResponseSchema.parse(response);
  });

  return { app, state };
}

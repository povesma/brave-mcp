import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeReply {
  result?: Record<string, unknown>;
  error?: { code: string; message?: string; retryable?: boolean };
  delayMs?: number;
}

export type FakeReplySource = FakeReply | ((params: Record<string, unknown>) => FakeReply);

export interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
  profile?: string;
}

const STATUS_BY_ERROR_CODE: Record<string, number> = {
  BRAVE_TIMEOUT: 504,
  BRAVE_AUTH_REQUIRED: 401,
  BRAVE_PROFILE_REQUIRED: 409,
  BRAVE_PROFILE_NOT_FOUND: 409,
};

export const FAKE_PROFILE = "Simulated";

// `profiles.list` is answered from `profiles` and kept out of `calls`, so readiness checks do not count as steps.
export class FakeDaemon {
  readonly calls: RecordedCall[] = [];
  extensionConnected = true;
  paired = true;
  profiles: string[] = [FAKE_PROFILE];
  protocolVersion: number | undefined = 2;

  private readonly queues = new Map<string, FakeReplySource[]>();
  private readonly fallbacks = new Map<string, FakeReplySource>();
  private readonly timers = new Set<NodeJS.Timeout>();

  private constructor(
    private readonly server: Server,
    readonly url: string,
    readonly token: string,
  ) {}

  static async start(token = "fake-daemon-token"): Promise<FakeDaemon> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const daemon = new FakeDaemon(server, `http://127.0.0.1:${port}`, token);
    server.on("request", (request, response) => void daemon.handle(request, response));
    return daemon;
  }

  reply(method: string, ...replies: FakeReplySource[]): this {
    const queue = this.queues.get(method) ?? [];
    queue.push(...replies);
    this.queues.set(method, queue);
    return this;
  }

  // The reply used for a method whenever its queue is empty.
  fallback(method: string, reply: FakeReplySource): this {
    this.fallbacks.set(method, reply);
    return this;
  }

  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private connectedProfiles(): string[] {
    return this.extensionConnected && this.paired ? this.profiles : [];
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "GET" && request.url === "/healthz") {
      send(response, 200, {
        ok: true,
        profileCount: this.connectedProfiles().length,
        ...(this.protocolVersion === undefined ? {} : { protocolVersion: this.protocolVersion }),
      });
      return;
    }
    if (request.method === "GET" && request.url === "/readyz") {
      send(response, 200, {
        ok: true,
        ready: true,
        extensionConnected: this.extensionConnected,
        paired: this.paired,
      });
      return;
    }
    if (request.method !== "POST" || request.url !== "/rpc") {
      send(response, 404, { ok: false });
      return;
    }

    const body = JSON.parse(await readBody(request)) as {
      id: string;
      method: string;
      params?: Record<string, unknown>;
      authToken?: string;
      profile?: string;
    };
    if (body.authToken !== this.token) {
      send(response, 401, errorReply(body.id, { code: "BRAVE_AUTH_REQUIRED", message: "Invalid daemon auth token." }));
      return;
    }

    if (body.method === "profiles.list") {
      const connectedAt = new Date(0).toISOString();
      const profiles = this.connectedProfiles().map((nickname) => ({ nickname, connectedAt }));
      send(response, 200, { id: body.id, ok: true, result: { profiles } });
      return;
    }

    const params = body.params ?? {};
    this.calls.push({ method: body.method, params, ...(body.profile === undefined ? {} : { profile: body.profile }) });

    const source = this.queues.get(body.method)?.shift() ?? this.fallbacks.get(body.method);
    const reply: FakeReply =
      source === undefined
        ? { error: { code: "BRAVE_INTERNAL_ERROR", message: `fake daemon: no scripted reply for ${body.method}` } }
        : typeof source === "function"
          ? source(params)
          : source;

    const deliver = (): void => {
      if (reply.error) {
        send(response, STATUS_BY_ERROR_CODE[reply.error.code] ?? 503, errorReply(body.id, reply.error));
      } else {
        send(response, 200, { id: body.id, ok: true, result: reply.result ?? {} });
      }
    };

    if (reply.delayMs === undefined) {
      deliver();
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      deliver();
    }, reply.delayMs);
    this.timers.add(timer);
  }
}

function errorReply(id: string, error: NonNullable<FakeReply["error"]>): Record<string, unknown> {
  return {
    id,
    ok: false,
    error: {
      code: error.code,
      message: error.message ?? error.code,
      retryable: error.retryable ?? false,
    },
  };
}

function send(response: ServerResponse, status: number, body: Record<string, unknown>): void {
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

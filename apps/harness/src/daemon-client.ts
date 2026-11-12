import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  clickInputSchema,
  clickOutputSchema,
  closeTabInputSchema,
  closeTabOutputSchema,
  daemonErrorCodeSchema,
  daemonResponseSchema,
  getTabInfoInputSchema,
  getTabInfoOutputSchema,
  listTabsInputSchema,
  listTabsOutputSchema,
  navigateInputSchema,
  navigateOutputSchema,
  openTabInputSchema,
  openTabOutputSchema,
  pressKeyInputSchema,
  pressKeyOutputSchema,
  typeTextInputSchema,
  typeTextOutputSchema,
  waitForSelectorInputSchema,
  waitForSelectorOutputSchema,
} from "@brave-mcp/protocol";
import { z } from "zod";

export const TOKEN_ENV_VARIABLE = "BRAVE_MCP_AUTH_TOKEN";

const DEFAULT_DAEMON_URL = "http://127.0.0.1:39200";
const DAEMON_MINIMUM_WAIT_MS = 5_000;
const DAEMON_WAIT_MARGIN_MS = 500;
const CLIENT_MARGIN_MS = 2_000;
const READINESS_TIME_LIMIT_MS = 5_000;

const METHODS = {
  "tabs.open": { input: openTabInputSchema, output: openTabOutputSchema },
  "tabs.list": { input: listTabsInputSchema, output: listTabsOutputSchema },
  "tabs.getInfo": { input: getTabInfoInputSchema, output: getTabInfoOutputSchema },
  "tabs.navigate": { input: navigateInputSchema, output: navigateOutputSchema },
  "tabs.close": { input: closeTabInputSchema, output: closeTabOutputSchema },
  "dom.waitForSelector": { input: waitForSelectorInputSchema, output: waitForSelectorOutputSchema },
  "dom.type": { input: typeTextInputSchema, output: typeTextOutputSchema },
  "dom.click": { input: clickInputSchema, output: clickOutputSchema },
  "input.pressKey": { input: pressKeyInputSchema, output: pressKeyOutputSchema },
} as const;

const daemonConfigSchema = z.object({
  version: z.literal(1),
  secret: z.string().min(1),
});

const readinessSchema = z.object({
  extensionConnected: z.boolean(),
  paired: z.boolean(),
});

export type HarnessMethod = keyof typeof METHODS;
export type MethodParams<M extends HarnessMethod> = z.input<(typeof METHODS)[M]["input"]>;
export type MethodResult<M extends HarnessMethod> = z.output<(typeof METHODS)[M]["output"]>;
export type DaemonErrorCode = z.infer<typeof daemonErrorCodeSchema>;

export interface DaemonLocation {
  daemonUrl: string;
  authToken: string;
}

export interface DaemonClientOptions {
  timeLimitMs?: number;
}

export class DaemonError extends Error {
  constructor(
    readonly code: DaemonErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

export class DaemonUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonUnavailableError";
  }
}

export class InvalidParamsError extends Error {
  constructor(method: string, detail: string) {
    super(`${method}: invalid parameters (${detail})`);
    this.name = "InvalidParamsError";
  }
}

export function daemonConfigDir(env: NodeJS.ProcessEnv): string {
  return resolve(env.BRAVE_MCP_CONFIG_DIR ?? join(homedir(), ".local", "share", "brave-mcp"));
}

export async function locateDaemon(env: NodeJS.ProcessEnv = process.env): Promise<DaemonLocation> {
  const daemonUrl = env.BRAVE_MCP_DAEMON_URL ?? DEFAULT_DAEMON_URL;
  const explicitToken = env[TOKEN_ENV_VARIABLE];
  if (explicitToken) {
    return { daemonUrl, authToken: explicitToken };
  }

  try {
    const raw = await readFile(join(daemonConfigDir(env), "daemon-config.json"), "utf8");
    return { daemonUrl, authToken: daemonConfigSchema.parse(JSON.parse(raw)).secret };
  } catch {
    throw new DaemonUnavailableError("the daemon config file is missing or unreadable; has the daemon ever started?");
  }
}

export class DaemonClient {
  constructor(
    private readonly location: DaemonLocation,
    private readonly options: DaemonClientOptions = {},
  ) {}

  async call<M extends HarnessMethod>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    const schemas: { input: z.ZodTypeAny; output: z.ZodTypeAny } = METHODS[method];

    const parsedParams = schemas.input.safeParse(params);
    if (!parsedParams.success) {
      const detail = parsedParams.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      throw new InvalidParamsError(method, detail);
    }
    const sentParams = parsedParams.data as Record<string, unknown>;

    const body = await this.request("/rpc", this.options.timeLimitMs ?? defaultTimeLimit(sentParams), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: randomUUID(),
        method,
        params: sentParams,
        authToken: this.location.authToken,
      }),
    });

    const reply = daemonResponseSchema.safeParse(body);
    if (!reply.success) {
      throw new DaemonError("BRAVE_INTERNAL_ERROR", `${method}: the daemon reply has an unexpected shape`);
    }
    if (!reply.data.ok) {
      throw new DaemonError(reply.data.error.code, reply.data.error.message);
    }

    const result = schemas.output.safeParse(reply.data.result);
    if (!result.success) {
      throw new DaemonError("BRAVE_INTERNAL_ERROR", `${method}: the result lacks its expected fields`);
    }
    return result.data as MethodResult<M>;
  }

  async connected(): Promise<boolean> {
    const body = await this.request("/readyz", this.options.timeLimitMs ?? READINESS_TIME_LIMIT_MS, { method: "GET" });
    const readiness = readinessSchema.safeParse(body);
    if (!readiness.success) {
      throw new DaemonUnavailableError("the daemon readiness reply has an unexpected shape");
    }
    return readiness.data.extensionConnected && readiness.data.paired;
  }

  private async request(path: string, timeLimitMs: number, init: RequestInit): Promise<unknown> {
    try {
      const response = await fetch(`${this.location.daemonUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeLimitMs),
      });
      return await response.json();
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new DaemonError("BRAVE_TIMEOUT", `no reply from the daemon within ${timeLimitMs} ms`);
      }
      if (error instanceof SyntaxError) {
        throw new DaemonError("BRAVE_INTERNAL_ERROR", "the daemon reply is not JSON");
      }
      throw new DaemonUnavailableError(`the daemon is not reachable at ${this.location.daemonUrl}`);
    }
  }
}

function defaultTimeLimit(params: Record<string, unknown>): number {
  const daemonWaitMs =
    typeof params.timeoutMs === "number"
      ? Math.max(DAEMON_MINIMUM_WAIT_MS, params.timeoutMs + DAEMON_WAIT_MARGIN_MS)
      : DAEMON_MINIMUM_WAIT_MS;
  return daemonWaitMs + CLIENT_MARGIN_MS;
}

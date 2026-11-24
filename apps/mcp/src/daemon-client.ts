import { daemonResponseSchema, type DaemonMethod } from "@brave-mcp/protocol";

import type { McpRuntimeConfig } from "./config.js";

export class DaemonCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DaemonCallError";
  }
}

export class DaemonClient {
  constructor(
    private readonly config: McpRuntimeConfig,
    private readonly profile?: string,
  ) {}

  get defaultProfile(): string | undefined {
    return this.config.defaultProfile;
  }

  get profileLocked(): boolean {
    return this.config.profileLocked ?? false;
  }

  withProfile(profile: string | undefined): DaemonClient {
    return new DaemonClient(this.config, profile);
  }

  async call(method: DaemonMethod, params: Record<string, unknown> = {}) {
    const response = await fetch(`${this.config.daemonUrl}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: `req_${Date.now()}`,
        method,
        params,
        authToken: this.config.authToken,
        ...(this.profile === undefined ? {} : { profile: this.profile }),
      }),
    });

    const parsed = daemonResponseSchema.parse(await response.json());
    if (!parsed.ok) {
      throw new DaemonCallError(parsed.error.code, parsed.error.message, parsed.error.details);
    }

    return parsed.result;
  }
}


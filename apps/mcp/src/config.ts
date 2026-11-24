import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { profileNicknameSchema } from "@brave-mcp/protocol";
import { z } from "zod";

import { ensureDaemonAvailable } from "./daemon-bootstrap.js";

const daemonConfigSchema = z.object({
  version: z.literal(1),
  secret: z.string().min(1),
});

export interface McpRuntimeConfig {
  daemonUrl: string;
  authToken: string;
  defaultProfile?: string;
  profileLocked?: boolean;
}

export interface ResolveRuntimeConfigOptions {
  daemonUrl?: string;
  authToken?: string;
  configDir?: string;
  defaultProfile?: string;
  profileLocked?: boolean;
}

function defaultConfigDir(): string {
  return join(homedir(), ".local", "share", "brave-mcp");
}

interface ProfileSettings {
  defaultProfile?: string;
  profileLocked: boolean;
}

function isLockOn(value: string | undefined): boolean {
  return value !== undefined && ["1", "true"].includes(value.trim().toLowerCase());
}

function resolveProfileSettings(options: ResolveRuntimeConfigOptions): ProfileSettings {
  const rawDefault = options.defaultProfile ?? process.env.BRAVE_MCP_PROFILE;
  const profileLocked = options.profileLocked ?? isLockOn(process.env.BRAVE_MCP_PROFILE_LOCK);
  let defaultProfile: string | undefined;
  if (rawDefault !== undefined && rawDefault.trim() !== "") {
    const parsed = profileNicknameSchema.safeParse(rawDefault);
    if (!parsed.success) {
      const rule = parsed.error.issues[0]?.message ?? "invalid nickname";
      throw new Error(`BRAVE_MCP_PROFILE is not a valid profile nickname: ${rule}`);
    }
    defaultProfile = parsed.data;
  }
  if (profileLocked && defaultProfile === undefined) {
    throw new Error("BRAVE_MCP_PROFILE_LOCK requires a default profile in BRAVE_MCP_PROFILE.");
  }
  return { ...(defaultProfile === undefined ? {} : { defaultProfile }), profileLocked };
}

export async function resolveRuntimeConfig(
  options: ResolveRuntimeConfigOptions = {},
): Promise<McpRuntimeConfig> {
  const profileSettings = resolveProfileSettings(options);
  const daemonUrl =
    options.daemonUrl ??
    process.env.BRAVE_MCP_DAEMON_URL ??
    "http://127.0.0.1:39200";
  const configDir = resolve(
    options.configDir ??
      process.env.BRAVE_MCP_CONFIG_DIR ??
      defaultConfigDir(),
  );
  const explicitAuthToken =
    options.authToken ?? process.env.BRAVE_MCP_AUTH_TOKEN ?? undefined;

  await ensureDaemonAvailable({
    daemonUrl,
    configDir,
    ...(explicitAuthToken ? { authToken: explicitAuthToken } : {}),
  });

  if (explicitAuthToken) {
    return {
      daemonUrl,
      authToken: explicitAuthToken,
      ...profileSettings,
    };
  }

  const raw = await readFile(join(configDir, "daemon-config.json"), "utf8");
  const parsed = daemonConfigSchema.parse(JSON.parse(raw));
  return {
    daemonUrl,
    authToken: parsed.secret,
    ...profileSettings,
  };
}

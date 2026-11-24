import { BRIDGE_CLOSE_CODES, PROFILE_NICKNAME_RULE, profileNicknameSchema } from "@brave-mcp/protocol";

export interface KeyValueStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface RefusalRecord {
  code: number;
  reason: string;
  nickname: string;
  daemonUrl: string;
}

export interface ConnectionInputs {
  authToken: string;
  profileNickname: string;
  daemonUrl: string;
  refusal: RefusalRecord | null;
}

export type ConnectDecision = { connect: true; nickname: string } | { connect: false; reason: string };

export type NicknameCheck = { ok: true; nickname: string } | { ok: false; reason: string };

export interface LaunchParameters {
  daemonUrl?: string;
  authToken?: string;
  profileNickname?: string;
  autosave: boolean;
}

export type RefusalClearingEvent = { kind: "settings"; changedKeys: string[] } | { kind: "reconnect" };

export const INSTALLATION_ID_KEY = "installationId";
export const REFUSAL_KEY = "bridgeRefusal";
export const CONNECTION_SETTING_KEYS = ["daemonUrl", "authToken", "profileNickname"] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const REFUSAL_CODES = new Set<number>([
  BRIDGE_CLOSE_CODES.invalidHello,
  BRIDGE_CLOSE_CODES.nicknameInUse,
  BRIDGE_CLOSE_CODES.extensionTooOld,
]);

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function createInstallationIdStore(
  storage: KeyValueStorage,
  generate: () => string = () => crypto.randomUUID(),
): { ensureInstallationId(): Promise<string> } {
  let inFlight: Promise<string> | null = null;

  async function readOrCreate(): Promise<string> {
    const stored = (await storage.get([INSTALLATION_ID_KEY]))[INSTALLATION_ID_KEY];
    if (isUuid(stored)) {
      return stored;
    }

    await storage.set({ [INSTALLATION_ID_KEY]: generate() });
    const reread = (await storage.get([INSTALLATION_ID_KEY]))[INSTALLATION_ID_KEY];
    if (!isUuid(reread)) {
      throw new Error("The installation id could not be stored.");
    }
    return reread;
  }

  return {
    ensureInstallationId() {
      inFlight ??= readOrCreate().catch((error: unknown) => {
        inFlight = null;
        throw error;
      });
      return inFlight;
    },
  };
}

export function checkNickname(value: string): NicknameCheck {
  const parsed = profileNicknameSchema.safeParse(value);
  return parsed.success ? { ok: true, nickname: parsed.data } : { ok: false, reason: PROFILE_NICKNAME_RULE };
}

export function isRefusal(code: number): boolean {
  return REFUSAL_CODES.has(code);
}

export function shouldConnect(inputs: ConnectionInputs): ConnectDecision {
  if (!inputs.authToken) {
    return { connect: false, reason: "Auth token is not configured." };
  }

  const nickname = checkNickname(inputs.profileNickname);
  if (!nickname.ok) {
    return { connect: false, reason: `Profile nickname is required (${PROFILE_NICKNAME_RULE}).` };
  }

  const refusal = inputs.refusal;
  if (refusal && refusal.nickname === nickname.nickname && refusal.daemonUrl === inputs.daemonUrl) {
    return {
      connect: false,
      reason: `The daemon refused this profile: ${refusal.reason}. Change the settings or press Reconnect Now.`,
    };
  }

  return { connect: true, nickname: nickname.nickname };
}

export function shouldKeepAlarm(inputs: ConnectionInputs): boolean {
  return shouldConnect(inputs).connect;
}

export function clearsRefusal(event: RefusalClearingEvent): boolean {
  if (event.kind === "reconnect") {
    return true;
  }
  return event.changedKeys.some((key) => (CONNECTION_SETTING_KEYS as readonly string[]).includes(key));
}

function isRefusalRecord(value: unknown): value is RefusalRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.code === "number" &&
    typeof record.reason === "string" &&
    typeof record.nickname === "string" &&
    typeof record.daemonUrl === "string"
  );
}

export async function readRefusal(storage: KeyValueStorage): Promise<RefusalRecord | null> {
  const stored = (await storage.get([REFUSAL_KEY]))[REFUSAL_KEY];
  return isRefusalRecord(stored) ? stored : null;
}

export async function writeRefusal(storage: KeyValueStorage, record: RefusalRecord): Promise<void> {
  await storage.set({ [REFUSAL_KEY]: record });
}

export async function clearRefusal(storage: KeyValueStorage): Promise<void> {
  await storage.remove([REFUSAL_KEY]);
}

export function parseLaunchParameters(search: string): LaunchParameters {
  const params = new URLSearchParams(search);
  const read = (name: string) => params.get(name)?.trim() || undefined;
  const daemonUrl = read("daemonUrl");
  const authToken = read("authToken");
  const profileNickname = read("profileNickname");
  const autosave = read("autosave")?.toLowerCase();

  return {
    ...(daemonUrl !== undefined ? { daemonUrl } : {}),
    ...(authToken !== undefined ? { authToken } : {}),
    ...(profileNickname !== undefined ? { profileNickname } : {}),
    autosave: autosave === "1" || autosave === "true",
  };
}

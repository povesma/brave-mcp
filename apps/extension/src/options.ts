import { PROFILE_NICKNAME_RULE } from "@brave-mcp/protocol";

import { checkNickname, parseLaunchParameters } from "./bridge-identity.js";

interface ExtensionSettings {
  daemonUrl: string;
  authToken: string;
  profileNickname: string;
}

interface BridgeStatus {
  state: "disconnected" | "connecting" | "connected";
  daemonUrl: string;
  profileNickname?: string;
  authConfigured: boolean;
  lastAttemptAt: string | null;
  lastConnectedAt: string | null;
  lastError: string | null;
}

const DEFAULT_DAEMON_URL = "ws://127.0.0.1:39200/extension/connect";

function getStorage(): chrome.storage.StorageArea {
  return chrome.storage.local;
}

async function loadSettings(): Promise<ExtensionSettings> {
  const result = await getStorage().get(["daemonUrl", "authToken", "profileNickname"]);
  return {
    daemonUrl:
      typeof result.daemonUrl === "string" && result.daemonUrl.length > 0
        ? result.daemonUrl
        : DEFAULT_DAEMON_URL,
    authToken: typeof result.authToken === "string" ? result.authToken : "",
    profileNickname: typeof result.profileNickname === "string" ? result.profileNickname : "",
  };
}

async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await getStorage().set(settings);
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }

  return element as T;
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return "Never";
  }

  return new Date(value).toLocaleString();
}

function renderBridgeStatus(status: BridgeStatus): string {
  const stateLabel =
    status.state === "connected"
      ? "Connected"
      : status.state === "connecting"
        ? "Connecting"
        : "Disconnected";

  const lines = [
    `State: ${stateLabel}`,
    `Profile nickname: ${status.profileNickname || "Not set"}`,
    `Daemon URL: ${status.daemonUrl}`,
    `Auth token configured: ${status.authConfigured ? "Yes" : "No"}`,
    `Last attempt: ${formatTimestamp(status.lastAttemptAt)}`,
    `Last connected: ${formatTimestamp(status.lastConnectedAt)}`,
  ];

  if (status.lastError) {
    lines.push(`Last error: ${status.lastError}`);
  }

  return lines.join("\n");
}

async function requestBridgeStatus(): Promise<BridgeStatus> {
  return chrome.runtime.sendMessage({
    type: "get-bridge-status",
  }) as Promise<BridgeStatus>;
}

async function requestReconnect(): Promise<BridgeStatus> {
  return chrome.runtime.sendMessage({
    type: "reconnect-bridge",
  }) as Promise<BridgeStatus>;
}

type SaveResult = { saved: true; status: BridgeStatus } | { saved: false; reason: string };

async function persistAndReconnect(
  daemonUrl: string,
  authToken: string,
  profileNickname: string,
): Promise<SaveResult> {
  const nickname = checkNickname(profileNickname);
  if (!nickname.ok) {
    return { saved: false, reason: `Profile nickname not saved. Use ${nickname.reason}.` };
  }

  await saveSettings({
    daemonUrl: daemonUrl.trim() || DEFAULT_DAEMON_URL,
    authToken: authToken.trim(),
    profileNickname: nickname.nickname,
  });

  return { saved: true, status: await requestReconnect() };
}

async function main(): Promise<void> {
  const form = byId<HTMLFormElement>("settings-form");
  const daemonUrlInput = byId<HTMLInputElement>("daemon-url");
  const authTokenInput = byId<HTMLInputElement>("auth-token");
  const nicknameInput = byId<HTMLInputElement>("profile-nickname");
  const nicknameRule = byId<HTMLElement>("profile-nickname-rule");
  const status = byId<HTMLParagraphElement>("status");
  const bridgeStatus = byId<HTMLPreElement>("bridge-status");
  const reconnectButton = byId<HTMLButtonElement>("reconnect-button");

  nicknameRule.textContent = `Use ${PROFILE_NICKNAME_RULE}.`;

  const settings = await loadSettings();
  const launch = parseLaunchParameters(window.location.search);

  daemonUrlInput.value = launch.daemonUrl ?? settings.daemonUrl;
  authTokenInput.value = launch.authToken ?? settings.authToken;
  nicknameInput.value = launch.profileNickname ?? settings.profileNickname;

  const showSaveResult = (result: SaveResult, savedText: string) => {
    if (result.saved) {
      bridgeStatus.textContent = renderBridgeStatus(result.status);
      status.textContent = savedText;
    } else {
      status.textContent = result.reason;
    }
  };

  if (
    launch.autosave &&
    (launch.daemonUrl !== undefined || launch.authToken !== undefined || launch.profileNickname !== undefined)
  ) {
    showSaveResult(
      await persistAndReconnect(daemonUrlInput.value, authTokenInput.value, nicknameInput.value),
      "Saved from launch parameters and reconnect requested.",
    );
  }

  bridgeStatus.textContent = renderBridgeStatus(await requestBridgeStatus());

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      showSaveResult(
        await persistAndReconnect(daemonUrlInput.value, authTokenInput.value, nicknameInput.value),
        "Saved and reconnect requested.",
      );
    })();
  });

  reconnectButton.addEventListener("click", () => {
    void (async () => {
      const latestStatus = await requestReconnect();
      bridgeStatus.textContent = renderBridgeStatus(latestStatus);
      status.textContent = "Reconnect requested.";
    })();
  });

  window.setInterval(() => {
    void (async () => {
      bridgeStatus.textContent = renderBridgeStatus(await requestBridgeStatus());
    })();
  }, 2_000);
}

void main();

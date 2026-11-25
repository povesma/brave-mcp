import { PROFILE_NICKNAME_RULE } from "@brave-mcp/protocol";

import { checkNickname, parseLaunchParameters, readRefusal, saveOutcomeMessage } from "./bridge-identity.js";

// The daemon decides a nickname clash after probing the current holder for up to 2 s.
const SAVE_RESULT_WAIT_MS = 3_000;
const SAVE_RESULT_POLL_MS = 250;

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

type SaveResult = { saved: true; status: BridgeStatus; message: string } | { saved: false; reason: string };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForConnectionResult(): Promise<BridgeStatus> {
  const deadline = Date.now() + SAVE_RESULT_WAIT_MS;
  let status = await requestBridgeStatus();
  while (Date.now() < deadline && status.state !== "disconnected") {
    await delay(SAVE_RESULT_POLL_MS);
    status = await requestBridgeStatus();
  }
  return status;
}

async function persistAndReconnect(
  daemonUrl: string,
  authToken: string,
  profileNickname: string,
): Promise<SaveResult> {
  const nickname = checkNickname(profileNickname);
  if (!nickname.ok) {
    return { saved: false, reason: `Profile nickname not saved. Use ${nickname.reason}.` };
  }

  const settings = {
    daemonUrl: daemonUrl.trim() || DEFAULT_DAEMON_URL,
    authToken: authToken.trim(),
    profileNickname: nickname.nickname,
  };
  await saveSettings(settings);
  await requestReconnect();

  const status = await waitForConnectionResult();
  const message = saveOutcomeMessage({
    state: status.state,
    lastError: status.lastError,
    nickname: settings.profileNickname,
    daemonUrl: settings.daemonUrl,
    refusal: await readRefusal(getStorage()),
  });
  return { saved: true, status, message };
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

  const showSaveResult = (result: SaveResult) => {
    if (result.saved) {
      bridgeStatus.textContent = renderBridgeStatus(result.status);
      status.textContent = result.message;
    } else {
      status.textContent = result.reason;
    }
  };

  if (
    launch.autosave &&
    (launch.daemonUrl !== undefined || launch.authToken !== undefined || launch.profileNickname !== undefined)
  ) {
    status.textContent = "Saving from launch parameters and connecting…";
    showSaveResult(await persistAndReconnect(daemonUrlInput.value, authTokenInput.value, nicknameInput.value));
  }

  bridgeStatus.textContent = renderBridgeStatus(await requestBridgeStatus());

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      status.textContent = "Saving and connecting…";
      showSaveResult(await persistAndReconnect(daemonUrlInput.value, authTokenInput.value, nicknameInput.value));
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

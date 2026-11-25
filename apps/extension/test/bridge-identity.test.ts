import assert from "node:assert/strict";
import { test } from "node:test";

import { BRIDGE_CLOSE_CODES, PROFILE_NICKNAME_RULE } from "@brave-mcp/protocol";

import {
  checkNickname,
  clearRefusal,
  clearsRefusal,
  createInstallationIdStore,
  isRefusal,
  parseLaunchParameters,
  readRefusal,
  saveOutcomeMessage,
  shouldConnect,
  shouldKeepAlarm,
  writeRefusal,
  type ConnectionInputs,
  type KeyValueStorage,
  type RefusalRecord,
} from "../src/bridge-identity.js";

const DAEMON_URL = "ws://127.0.0.1:39200/extension/connect";

function memoryStorage(): KeyValueStorage & { data: Map<string, unknown>; writes: number } {
  const data = new Map<string, unknown>();
  const storage = {
    data,
    writes: 0,
    async get(keys: string[]) {
      await Promise.resolve();
      return Object.fromEntries(keys.filter((key) => data.has(key)).map((key) => [key, data.get(key)]));
    },
    async set(items: Record<string, unknown>) {
      await Promise.resolve();
      storage.writes += 1;
      for (const [key, value] of Object.entries(items)) {
        data.set(key, value);
      }
    },
    async remove(keys: string[]) {
      await Promise.resolve();
      for (const key of keys) {
        data.delete(key);
      }
    },
  };
  return storage;
}

function inputs(overrides: Partial<ConnectionInputs> = {}): ConnectionInputs {
  return {
    authToken: "secret",
    profileNickname: "Work",
    daemonUrl: DAEMON_URL,
    refusal: null,
    ...overrides,
  };
}

const workRefusal: RefusalRecord = {
  code: BRIDGE_CLOSE_CODES.nicknameInUse,
  reason: "nickname in use",
  nickname: "Work",
  daemonUrl: DAEMON_URL,
};

test("concurrent ensureInstallationId calls yield one id that survives a re-read", async () => {
  const storage = memoryStorage();
  let generated = 0;
  const store = createInstallationIdStore(storage, () => {
    generated += 1;
    return `3f2b8c1e-9a4d-4e6f-8b7a-00000000000${generated}`;
  });

  const ids = await Promise.all([store.ensureInstallationId(), store.ensureInstallationId(), store.ensureInstallationId()]);

  assert.equal(new Set(ids).size, 1);
  assert.equal(generated, 1);
  const restarted = createInstallationIdStore(storage, () => "ffffffff-ffff-4fff-8fff-ffffffffffff");
  assert.equal(await restarted.ensureInstallationId(), ids[0]);
});

test("a stored value that is not a UUID is replaced", async () => {
  const storage = memoryStorage();
  storage.data.set("installationId", "not-a-uuid");
  const store = createInstallationIdStore(storage, () => "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b");

  assert.equal(await store.ensureInstallationId(), "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b");
});

test("the nickname check uses the protocol rule", () => {
  assert.deepEqual(checkNickname("  Work  "), { ok: true, nickname: "Work" });
  assert.deepEqual(checkNickname("-bad"), { ok: false, reason: PROFILE_NICKNAME_RULE });
  assert.deepEqual(checkNickname(""), { ok: false, reason: PROFILE_NICKNAME_RULE });
  assert.equal(checkNickname("a".repeat(33)).ok, false);
});

test("4400, 4409 and 4426 are refusals; 4000, 4408 and ordinary closes are not", () => {
  for (const code of [4400, 4409, 4426]) {
    assert.equal(isRefusal(code), true, String(code));
  }
  for (const code of [4000, 4408, 1000, 1006]) {
    assert.equal(isRefusal(code), false, String(code));
  }
});

test("shouldConnect is false without a token, without a valid nickname, or with a matching refusal", () => {
  assert.deepEqual(shouldConnect(inputs()), { connect: true, nickname: "Work" });

  const noToken = shouldConnect(inputs({ authToken: "" }));
  assert.equal(noToken.connect, false);

  const noNickname = shouldConnect(inputs({ profileNickname: "" }));
  assert.equal(noNickname.connect, false);
  assert.match(noNickname.connect ? "" : noNickname.reason, /nickname/i);

  const refused = shouldConnect(inputs({ refusal: workRefusal }));
  assert.equal(refused.connect, false);
  assert.match(refused.connect ? "" : refused.reason, /nickname in use/);
});

test("a refusal for another nickname or another daemon URL does not block", () => {
  assert.equal(shouldConnect(inputs({ refusal: { ...workRefusal, nickname: "Home" } })).connect, true);
  assert.equal(
    shouldConnect(inputs({ refusal: { ...workRefusal, daemonUrl: "ws://127.0.0.1:1/extension/connect" } })).connect,
    true,
  );
});

test("shouldKeepAlarm follows the same inputs", () => {
  assert.equal(shouldKeepAlarm(inputs()), true);
  assert.equal(shouldKeepAlarm(inputs({ authToken: "" })), false);
  assert.equal(shouldKeepAlarm(inputs({ profileNickname: "-bad" })), false);
  assert.equal(shouldKeepAlarm(inputs({ refusal: workRefusal })), false);
});

test("a changed nickname, token or URL, or a Reconnect, clears the refusal; other changes do not", () => {
  for (const key of ["profileNickname", "authToken", "daemonUrl"]) {
    assert.equal(clearsRefusal({ kind: "settings", changedKeys: [key] }), true, key);
  }
  assert.equal(clearsRefusal({ kind: "reconnect" }), true);
  assert.equal(clearsRefusal({ kind: "settings", changedKeys: ["bridgeStatus"] }), false);
});

test("the refusal record is written, read back and cleared", async () => {
  const storage = memoryStorage();
  assert.equal(await readRefusal(storage), null);
  await writeRefusal(storage, workRefusal);
  assert.deepEqual(await readRefusal(storage), workRefusal);
  await clearRefusal(storage);
  assert.equal(await readRefusal(storage), null);
});

test("the launch-parameter parser reads profileNickname", () => {
  assert.deepEqual(parseLaunchParameters("?daemonUrl=ws%3A%2F%2Fh&authToken=t&profileNickname=%20Work%20&autosave=1"), {
    daemonUrl: "ws://h",
    authToken: "t",
    profileNickname: "Work",
    autosave: true,
  });
  assert.deepEqual(parseLaunchParameters(""), { autosave: false });
});

test("after a save, a nickname clash is reported as not connected, never as saved", () => {
  const message = saveOutcomeMessage({
    state: "disconnected",
    lastError: "The daemon refused this profile: nickname in use. Change the settings or press Reconnect Now.",
    nickname: "Work",
    daemonUrl: DAEMON_URL,
    refusal: { code: BRIDGE_CLOSE_CODES.nicknameInUse, reason: "nickname in use", nickname: "Work", daemonUrl: DAEMON_URL },
  });
  assert.equal(
    message,
    'Not connected: nickname "Work" is already used by another connected profile. Choose another nickname.',
  );
});

test("after a save, another refusal is reported with its reason", () => {
  const message = saveOutcomeMessage({
    state: "disconnected",
    lastError: null,
    nickname: "Work",
    daemonUrl: DAEMON_URL,
    refusal: { code: BRIDGE_CLOSE_CODES.invalidHello, reason: "invalid hello", nickname: "Work", daemonUrl: DAEMON_URL },
  });
  assert.match(message, /^Not connected: the daemon refused this profile \(invalid hello\)\./);
  assert.doesNotMatch(message, /Saved/);
});

test("after a save, a connection is reported with its nickname; an old refusal for another nickname is ignored", () => {
  const message = saveOutcomeMessage({
    state: "connected",
    lastError: null,
    nickname: "Home",
    daemonUrl: DAEMON_URL,
    refusal: workRefusal,
  });
  assert.equal(message, 'Saved and connected as "Home".');
});

test("after a save, a failed or pending connection says it is not connected yet", () => {
  const failed = saveOutcomeMessage({
    state: "disconnected",
    lastError: "WebSocket error while connecting to the daemon.",
    nickname: "Home",
    daemonUrl: DAEMON_URL,
    refusal: null,
  });
  assert.equal(failed, "Saved, but not connected. WebSocket error while connecting to the daemon.");
  const pending = saveOutcomeMessage({
    state: "connecting",
    lastError: null,
    nickname: "Home",
    daemonUrl: DAEMON_URL,
    refusal: null,
  });
  assert.equal(pending, "Saved; still connecting to the daemon.");
});

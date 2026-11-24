import { readFileSync } from "node:fs";

import {
  BRIDGE_CLOSE_CODES,
  bridgeClientMessageSchema,
  bridgeHelloMessageSchema,
  bridgeRequestMessageSchema,
  daemonErrorCodeSchema,
  daemonMethodSchema,
  daemonRequestSchema,
  daemonResponseSchema,
  PROFILE_NICKNAME_MAX_LENGTH,
  PROTOCOL_VERSION,
  profileKey,
  profileNicknameSchema,
  toolCatalog,
} from "./index.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const seenNames = new Set<string>();
for (const tool of toolCatalog) {
  assert(!seenNames.has(tool.name), `Duplicate tool name: ${tool.name}`);
  seenNames.add(tool.name);

  const sampleInputResult = tool.inputSchema.safeParse({});
  if (!sampleInputResult.success) {
    // Some tools require mandatory fields; that is expected.
    assert(
      sampleInputResult.error.issues.length > 0,
      `Tool ${tool.name} returned an empty validation error set`,
    );
  }

  const sampleOutputResult = tool.outputSchema.safeParse({});
  if (!sampleOutputResult.success) {
    assert(
      sampleOutputResult.error.issues.length > 0,
      `Tool ${tool.name} returned an empty output validation error set`,
    );
  }
}

const requestResult = daemonRequestSchema.safeParse({
  id: "req_123",
  method: "tabs.list",
  params: {},
  authToken: "secret",
});
assert(requestResult.success, "Sample daemon request should parse");

const successResponseResult = daemonResponseSchema.safeParse({
  id: "req_123",
  ok: true,
  result: { tabs: [] },
});
assert(successResponseResult.success, "Sample daemon success response should parse");

const errorResponseResult = daemonResponseSchema.safeParse({
  id: "req_123",
  ok: false,
  error: {
    code: "BRAVE_SELECTOR_NOT_FOUND",
    message: "Selector not found before timeout.",
    retryable: false,
  },
});
assert(errorResponseResult.success, "Sample daemon error response should parse");

const bridgeHelloResult = bridgeClientMessageSchema.safeParse({
  type: "hello",
  browser: "brave",
  version: "0.0.1",
});
assert(bridgeHelloResult.success, "Sample bridge hello should parse");

const bridgePingResult = bridgeClientMessageSchema.safeParse({
  type: "ping",
  sentAt: "2026-03-16T00:00:00.000Z",
});
assert(bridgePingResult.success, "Sample bridge ping should parse");

const bridgeRequestResult = bridgeRequestMessageSchema.safeParse({
  type: "request",
  id: "req_123",
  method: "tabs.list",
  params: {},
});
assert(bridgeRequestResult.success, "Sample bridge request should parse");

const BROWSER_TOOL_COUNT = 48;
const SAMPLE_INSTALLATION_ID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";

const profileChecks: Array<[string, () => boolean]> = [
  ["PROTOCOL_VERSION is 2", () => PROTOCOL_VERSION === 2],
  ["nickname max length is 32", () => PROFILE_NICKNAME_MAX_LENGTH === 32],
  ...["Work", "personal-2", "A b.c_d", "x", "9lives", "a".repeat(32)].map(
    (value): [string, () => boolean] => [
      `nickname accepts ${JSON.stringify(value)}`,
      () => profileNicknameSchema.safeParse(value).success,
    ],
  ),
  [
    "nickname is trimmed",
    () => {
      const result = profileNicknameSchema.safeParse("  Work  ");
      return result.success && result.data === "Work";
    },
  ],
  ...[
    "",
    "   ",
    "a".repeat(33),
    "-work",
    ".work",
    "_work",
    " _work",
    "a/b",
    "a\u0000b",
    "a\nb",
    "café",
    42,
  ].map((value): [string, () => boolean] => [
    `nickname rejects ${JSON.stringify(value)}`,
    () => !profileNicknameSchema.safeParse(value).success,
  ]),
  ["profileKey lowers case", () => profileKey("Work Laptop") === "work laptop"],
  [
    "request without profile parses",
    () => {
      const result = daemonRequestSchema.safeParse({ id: "r1", method: "tabs.list", authToken: "secret" });
      return result.success && !("profile" in result.data && result.data.profile !== undefined);
    },
  ],
  [
    "request keeps profile",
    () => {
      const result = daemonRequestSchema.safeParse({
        id: "r1",
        method: "tabs.list",
        authToken: "secret",
        profile: "Work",
      });
      return result.success && (result.data as Record<string, unknown>).profile === "Work";
    },
  ],
  [
    "request rejects an invalid profile",
    () =>
      !daemonRequestSchema.safeParse({ id: "r1", method: "tabs.list", authToken: "secret", profile: "-bad" })
        .success,
  ],
  ["profiles.list is a daemon method", () => daemonMethodSchema.safeParse("profiles.list").success],
  [
    "profiles.list request parses",
    () => daemonRequestSchema.safeParse({ id: "r1", method: "profiles.list", authToken: "secret" }).success,
  ],
  [
    "tool catalog keeps only browser tools",
    () =>
      toolCatalog.length === BROWSER_TOOL_COUNT &&
      !toolCatalog.some((tool) => /profile/i.test(tool.name)),
  ],
  ...["BRAVE_PROFILE_REQUIRED", "BRAVE_PROFILE_NOT_FOUND"].map((code): [string, () => boolean] => [
    `error response with ${code} parses`,
    () =>
      daemonResponseSchema.safeParse({
        id: "r1",
        ok: false,
        error: { code, message: "Choose a profile.", retryable: false, details: { connected: ["Work"] } },
      }).success,
  ]),
  [
    "0.0.1 hello parses",
    () => bridgeHelloMessageSchema.safeParse({ type: "hello", browser: "brave", version: "0.0.1" }).success,
  ],
  [
    "new hello keeps profile fields",
    () => {
      const result = bridgeHelloMessageSchema.safeParse({
        type: "hello",
        browser: "brave",
        version: "0.0.2",
        profile: "Work",
        installationId: SAMPLE_INSTALLATION_ID,
        protocolVersion: 2,
      });
      if (!result.success) {
        return false;
      }
      const data = result.data as Record<string, unknown>;
      return (
        data.profile === "Work" &&
        data.installationId === SAMPLE_INSTALLATION_ID &&
        data.protocolVersion === 2
      );
    },
  ],
  [
    "hello rejects a non-UUID installationId",
    () =>
      !bridgeHelloMessageSchema.safeParse({
        type: "hello",
        browser: "brave",
        version: "0.0.2",
        profile: "Work",
        installationId: "not-a-uuid",
        protocolVersion: 2,
      }).success,
  ],
  [
    "hello rejects an invalid profile",
    () =>
      !bridgeHelloMessageSchema.safeParse({
        type: "hello",
        browser: "brave",
        version: "0.0.2",
        profile: "a/b",
        installationId: SAMPLE_INSTALLATION_ID,
        protocolVersion: 2,
      }).success,
  ],
  [
    "close codes are 4000, 4400, 4408, 4409, 4426",
    () =>
      BRIDGE_CLOSE_CODES.replaced === 4000 &&
      BRIDGE_CLOSE_CODES.invalidHello === 4400 &&
      BRIDGE_CLOSE_CODES.helloTimeout === 4408 &&
      BRIDGE_CLOSE_CODES.nicknameInUse === 4409 &&
      BRIDGE_CLOSE_CODES.extensionTooOld === 4426,
  ],
];

const failedProfileChecks = profileChecks.filter(([, check]) => !check()).map(([name]) => name);
assert(
  failedProfileChecks.length === 0,
  `Profile checks failed (${failedProfileChecks.length} of ${profileChecks.length}):\n- ${failedProfileChecks.join("\n- ")}`,
);

interface JsonSchemaObject {
  properties?: Record<string, { type?: unknown; enum?: unknown[] } & JsonSchemaObject>;
  required?: string[];
  definitions?: Record<string, JsonSchemaObject>;
  anyOf?: JsonSchemaObject[];
}

function readSpec(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../../../specs/${path}`, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;
}

function sameMembers(listed: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(listed) &&
    listed.length === expected.length &&
    [...listed].sort().join("\n") === [...expected].sort().join("\n")
  );
}

function isOptionalString(schema: JsonSchemaObject | undefined, name: string): boolean {
  return schema?.properties?.[name]?.type === "string" && !(schema.required ?? []).includes(name);
}

const rpcSpec = readSpec("rpc/daemon-rpc.schema.json") as { properties: Record<string, JsonSchemaObject> };
const specRequest = rpcSpec.properties.request?.definitions?.DaemonRequest;
const specErrorBranch = rpcSpec.properties.response?.definitions?.DaemonResponse?.anyOf?.find(
  (branch) => branch.properties?.error !== undefined,
);
const toolsSpec = readSpec("tools/brave-tools.schema.json") as {
  $defs?: Record<string, JsonSchemaObject>;
  tools?: Array<{ name: string }>;
};

const specChecks: Array<[string, () => boolean]> = [
  [
    "RPC spec methods equal the protocol methods",
    () => sameMembers(specRequest?.properties?.method?.enum, daemonMethodSchema.options),
  ],
  [
    "RPC spec error codes equal the protocol error codes",
    () => sameMembers(specErrorBranch?.properties?.error?.properties?.code?.enum, daemonErrorCodeSchema.options),
  ],
  ["RPC spec request has an optional profile", () => isOptionalString(specRequest, "profile")],
  [
    "tools spec lists exactly the catalog tools",
    () => sameMembers(toolsSpec.tools?.map((tool) => tool.name), toolCatalog.map((tool) => tool.name)),
  ],
  [
    "tools spec declares the common optional profile input",
    () => isOptionalString(toolsSpec.$defs?.commonInput, "profile"),
  ],
];

const failedSpecChecks = specChecks.filter(([, check]) => !check()).map(([name]) => name);
assert(
  failedSpecChecks.length === 0,
  `Spec checks failed (${failedSpecChecks.length} of ${specChecks.length}):\n- ${failedSpecChecks.join("\n- ")}`,
);

console.log(
  JSON.stringify(
    {
      verifiedTools: toolCatalog.length,
      verifiedRpcMethods: requestResult.data.method,
      verifiedBridgeMessages: ["hello", "ping", "request"],
      verifiedProfileChecks: profileChecks.length,
      verifiedSpecChecks: specChecks.length,
    },
    null,
    2,
  ),
);

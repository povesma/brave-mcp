import { z } from "zod";

import {
  daemonErrorResponseSchema,
  daemonMethodSchema,
  daemonSuccessResponseSchema,
  profileNicknameSchema,
} from "./rpc.js";

export const BRIDGE_CLOSE_CODES = {
  replaced: 4000,
  invalidHello: 4400,
  helloTimeout: 4408,
  nicknameInUse: 4409,
  extensionTooOld: 4426,
} as const;

// Profile fields stay optional so a 0.0.1 hello parses and can be refused with a reason.
export const bridgeHelloMessageSchema = z.object({
  type: z.literal("hello"),
  browser: z.enum(["brave", "chromium"]),
  version: z.string().min(1),
  profile: profileNicknameSchema.optional(),
  installationId: z.string().uuid().optional(),
  protocolVersion: z.number().int().positive().optional(),
});

export const bridgePingMessageSchema = z.object({
  type: z.literal("ping"),
  sentAt: z.string().datetime(),
});

export const bridgeRequestMessageSchema = z.object({
  type: z.literal("request"),
  id: z.string().min(1),
  method: daemonMethodSchema,
  params: z.record(z.unknown()).default({}),
});

export const bridgeSuccessResponseMessageSchema = daemonSuccessResponseSchema.extend({
  type: z.literal("response"),
});

export const bridgeErrorResponseMessageSchema = daemonErrorResponseSchema.extend({
  type: z.literal("response"),
});

export const bridgeResponseMessageSchema = z.union([
  bridgeSuccessResponseMessageSchema,
  bridgeErrorResponseMessageSchema,
]);

export const bridgeClientMessageSchema = z.union([
  bridgeHelloMessageSchema,
  bridgePingMessageSchema,
  bridgeResponseMessageSchema,
]);

export type BridgeHelloMessage = z.infer<typeof bridgeHelloMessageSchema>;
export type BridgePingMessage = z.infer<typeof bridgePingMessageSchema>;
export type BridgeRequestMessage = z.infer<typeof bridgeRequestMessageSchema>;
export type BridgeResponseMessage = z.infer<typeof bridgeResponseMessageSchema>;
export type BridgeClientMessage = z.infer<typeof bridgeClientMessageSchema>;

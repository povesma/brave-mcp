import { z } from "zod";

export const PROTOCOL_VERSION = 2;

export const PROFILE_NICKNAME_MAX_LENGTH = 32;

export const PROFILE_NICKNAME_RULE =
  `1-${PROFILE_NICKNAME_MAX_LENGTH} characters: letters A-Z, digits, space, "-", "_" or ".", ` +
  "starting with a letter or digit";

export const profileNicknameSchema = z
  .string()
  .trim()
  .min(1, PROFILE_NICKNAME_RULE)
  .max(PROFILE_NICKNAME_MAX_LENGTH, PROFILE_NICKNAME_RULE)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/, PROFILE_NICKNAME_RULE);

export function profileKey(nickname: string): string {
  return nickname.toLowerCase();
}

export const daemonMethodSchema = z.enum([
  "tabs.list",
  "windows.list",
  "tabs.getActive",
  "tabs.getInfo",
  "windows.getInfo",
  "tabs.open",
  "windows.create",
  "tabs.close",
  "windows.close",
  "tabs.navigate",
  "tabs.reload",
  "tabs.back",
  "tabs.forward",
  "tabs.waitForNavigation",
  "tabs.switch",
  "tabs.focus",
  "tabs.setViewport",
  "dom.click",
  "dom.hover",
  "dom.type",
  "dom.selectOption",
  "dom.scrollTo",
  "dom.dragAndDrop",
  "dom.uploadFiles",
  "input.pressKey",
  "dom.waitForSelector",
  "dom.getVisibleText",
  "dom.getHtml",
  "dom.querySelector",
  "dom.queryElements",
  "dom.elementsFromPoint",
  "page.downloadAsset",
  "page.capturePdf",
  "page.captureScreenshot",
  "page.getConsoleLogs",
  "page.networkLog",
  "storage.cookieAccess",
  "network.requestIntercept",
  "network.mockResponse",
  "network.throttle",
  "storage.clear",
  "session.export",
  "page.setUserAgent",
  "page.emulateMedia",
  "browser.grantPermissions",
  "page.exportHar",
  "page.waitForIdle",
  "page.executeJavaScript",
  "profiles.list",
]);

export const daemonRequestSchema = z.object({
  id: z.string().min(1),
  method: daemonMethodSchema,
  params: z.record(z.unknown()).default({}),
  authToken: z.string().min(1),
  profile: profileNicknameSchema.optional(),
});

export const daemonSuccessResponseSchema = z.object({
  id: z.string().min(1),
  ok: z.literal(true),
  result: z.record(z.unknown()),
});

export const daemonErrorCodeSchema = z.enum([
  "BRAVE_AUTH_REQUIRED",
  "BRAVE_EXTENSION_OFFLINE",
  "BRAVE_TAB_NOT_FOUND",
  "BRAVE_SELECTOR_NOT_FOUND",
  "BRAVE_TIMEOUT",
  "BRAVE_PERMISSION_DENIED",
  "BRAVE_INTERNAL_ERROR",
  "BRAVE_PROFILE_REQUIRED",
  "BRAVE_PROFILE_NOT_FOUND",
]);

export const daemonErrorResponseSchema = z.object({
  id: z.string().min(1),
  ok: z.literal(false),
  error: z.object({
    code: daemonErrorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
    details: z.record(z.unknown()).optional(),
  }),
});

export const daemonResponseSchema = z.union([
  daemonSuccessResponseSchema,
  daemonErrorResponseSchema,
]);

export type DaemonMethod = z.infer<typeof daemonMethodSchema>;
export type DaemonRequest = z.infer<typeof daemonRequestSchema>;
export type DaemonSuccessResponse = z.infer<typeof daemonSuccessResponseSchema>;
export type DaemonErrorResponse = z.infer<typeof daemonErrorResponseSchema>;
export type DaemonResponse = z.infer<typeof daemonResponseSchema>;

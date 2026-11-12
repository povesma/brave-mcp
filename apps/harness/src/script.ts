import { readFile } from "node:fs/promises";

import { parseDocument } from "yaml";
import { z } from "zod";

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VARIABLE_REFERENCE = /\$\{([^}]*)\}/g;

const RISKY_STEP_TYPES = new Set([
  "execute_javascript",
  "run_js",
  "evaluate",
  "cookie_access",
  "cookies",
  "session_export",
  "export_session",
  "har_export",
]);

const variableNameSchema = z.string().regex(VARIABLE_NAME, "must be a variable name (letters, digits, underscore)");
const secondsSchema = z.number().positive();
const commandSchema = z.tuple([z.string().min(1)]).rest(z.string());
const envSchema = z.record(z.string());
const selectorSchema = z.string().min(1);

const onFailureSchema = z
  .object({
    retry: z
      .object({
        times: z.number().int().positive(),
        wait_s: z.number().nonnegative().default(1),
      })
      .strict()
      .optional(),
    then: z.enum(["stop", "pause"]).default("stop"),
  })
  .strict();

const selectorOnFailureSchema = onFailureSchema
  .extend({
    selectors: z.array(selectorSchema).default([]),
  })
  .strict();

const patternSchema = z.string().min(1).superRefine((pattern, ctx) => {
  try {
    new RegExp(pattern);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "is not a valid regular expression" });
  }
});

const stepSchemas = {
  open_tab: z.object({ url: z.string().min(1), on_failure: onFailureSchema.optional() }).strict(),
  use_tab: z
    .object({
      url_prefix: z.string().min(1),
      wait_s: z.number().nonnegative().default(3),
      open: z.string().min(1),
      on_failure: onFailureSchema.optional(),
    })
    .strict(),
  navigate: z
    .object({
      url: z.string().min(1),
      timeout_s: secondsSchema.default(30),
      on_failure: onFailureSchema.optional(),
    })
    .strict(),
  wait_for: z
    .object({
      selector: selectorSchema,
      state: z.enum(["attached", "visible"]).default("visible"),
      timeout_s: secondsSchema.default(30),
      on_failure: selectorOnFailureSchema.optional(),
    })
    .strict(),
  type: z
    .object({
      selector: selectorSchema,
      text: z.string(),
      on_failure: selectorOnFailureSchema.optional(),
    })
    .strict(),
  click: z.object({ selector: selectorSchema, on_failure: selectorOnFailureSchema.optional() }).strict(),
  press_key: z
    .object({
      key: z.string().min(1),
      modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).default([]),
      on_failure: onFailureSchema.optional(),
    })
    .strict(),
  close_tab: z.object({ on_failure: onFailureSchema.optional() }).strict(),
  run: z
    .object({
      cmd: commandSchema,
      capture: variableNameSchema.optional(),
      env: envSchema.optional(),
      timeout_s: secondsSchema.default(60),
      on_failure: onFailureSchema.optional(),
    })
    .strict(),
  start: z
    .object({
      id: z.string().min(1),
      cmd: commandSchema,
      env: envSchema.optional(),
      capture_match: z.object({ var: variableNameSchema, pattern: patternSchema }).strict().optional(),
      timeout_s: secondsSchema.default(30),
      on_failure: onFailureSchema.optional(),
    })
    .strict(),
  await: z
    .object({
      id: z.string().min(1),
      timeout_s: secondsSchema.default(120),
      on_failure: onFailureSchema.optional(),
    })
    .strict(),
} as const;

const preconditionSchema = z
  .object({
    cmd: commandSchema,
    env: envSchema.optional(),
    timeout_s: secondsSchema.default(60),
  })
  .strict();

const scriptSchema = z
  .object({
    name: z.string().min(1),
    pause_timeout_s: secondsSchema.default(600),
    precondition: preconditionSchema.optional(),
    steps: z.array(z.unknown()).min(1),
  })
  .strict();

export type StepKind = keyof typeof stepSchemas;
export type Step = { [K in StepKind]: { kind: K } & z.infer<(typeof stepSchemas)[K]> }[StepKind];
export type StepOf<K extends StepKind> = Extract<Step, { kind: K }>;
export type Precondition = z.infer<typeof preconditionSchema>;

export interface Script {
  name: string;
  pause_timeout_s: number;
  precondition?: Precondition;
  steps: Step[];
}

export interface ScriptProblem {
  step?: number;
  line?: number;
  reason: string;
}

export type LoadResult = { ok: true; script: Script } | { ok: false; problems: ScriptProblem[] };

export function formatProblem(problem: ScriptProblem): string {
  if (problem.step !== undefined) {
    return `step ${problem.step}: ${problem.reason}`;
  }
  if (problem.line !== undefined) {
    return `line ${problem.line}: ${problem.reason}`;
  }
  return problem.reason;
}

export async function loadScript(path: string): Promise<LoadResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown error";
    return { ok: false, problems: [{ reason: `cannot read script file (${code})` }] };
  }
  return parseScript(text);
}

export function parseScript(text: string): LoadResult {
  const document = parseDocument(text);
  if (document.errors.length > 0) {
    return {
      ok: false,
      problems: document.errors.map((error) => ({
        ...(error.linePos ? { line: error.linePos[0].line } : {}),
        reason: `YAML syntax: ${error.message.split("\n")[0] ?? error.code}`,
      })),
    };
  }

  const top = scriptSchema.safeParse(document.toJS());
  if (!top.success) {
    return { ok: false, problems: top.error.issues.map((issue) => ({ reason: describeIssue(issue) })) };
  }

  const problems: ScriptProblem[] = [];
  const steps: Step[] = [];
  top.data.steps.forEach((raw, index) => {
    const parsed = parseStep(raw);
    if ("step" in parsed) {
      steps.push(parsed.step);
    } else {
      problems.push(...parsed.reasons.map((reason) => ({ step: index + 1, reason })));
    }
  });

  for (const name of referencedVariables(preconditionStrings(top.data.precondition)).names) {
    problems.push({ reason: `precondition uses variable "${name}"; no variable exists before the steps run` });
  }

  if (problems.length === 0) {
    problems.push(...orderProblems(steps));
  }
  if (problems.length > 0) {
    return { ok: false, problems };
  }

  return {
    ok: true,
    script: {
      name: top.data.name,
      pause_timeout_s: top.data.pause_timeout_s,
      ...(top.data.precondition ? { precondition: top.data.precondition } : {}),
      steps,
    },
  };
}

export function capturedVariable(step: Step): string | undefined {
  if (step.kind === "run") {
    return step.capture;
  }
  if (step.kind === "start") {
    return step.capture_match?.var;
  }
  return undefined;
}

export function variablesUsed(step: Step): string[] {
  return referencedVariables(substitutableStrings(step)).names;
}

export function substituteStep<S extends Step>(step: S, lookup: (name: string) => string): S {
  const replace = (text: string): string => text.replace(VARIABLE_REFERENCE, (_, name: string) => lookup(name));
  const copy: Step = structuredClone(step);
  switch (copy.kind) {
    case "open_tab":
    case "navigate":
      copy.url = replace(copy.url);
      break;
    case "use_tab":
      copy.open = replace(copy.open);
      break;
    case "type":
      copy.text = replace(copy.text);
      break;
    case "run":
    case "start": {
      const [program, ...rest] = copy.cmd;
      copy.cmd = [replace(program), ...rest.map(replace)];
      if (copy.env) {
        copy.env = Object.fromEntries(Object.entries(copy.env).map(([key, value]) => [key, replace(value)]));
      }
      break;
    }
    default:
      break;
  }
  return copy as S;
}

function substitutableStrings(step: Step): string[] {
  switch (step.kind) {
    case "open_tab":
    case "navigate":
      return [step.url];
    case "use_tab":
      return [step.open];
    case "type":
      return [step.text];
    case "run":
    case "start":
      return [...step.cmd, ...Object.values(step.env ?? {})];
    default:
      return [];
  }
}

function preconditionStrings(precondition: Precondition | undefined): string[] {
  return precondition ? [...precondition.cmd, ...Object.values(precondition.env ?? {})] : [];
}

function referencedVariables(texts: string[]): { names: string[]; malformed: string[] } {
  const names = new Set<string>();
  const malformed = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(VARIABLE_REFERENCE)) {
      const name = match[1] ?? "";
      if (VARIABLE_NAME.test(name)) {
        names.add(name);
      } else {
        malformed.add(match[0]);
      }
    }
  }
  return { names: [...names], malformed: [...malformed] };
}

function parseStep(raw: unknown): { step: Step } | { reasons: string[] } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { reasons: ["a step must be a mapping from one step type to its fields"] };
  }
  const keys = Object.keys(raw);
  const kind = keys[0];
  if (keys.length !== 1 || kind === undefined) {
    return { reasons: [`a step must name exactly one step type, found ${keys.length}`] };
  }
  if (RISKY_STEP_TYPES.has(kind)) {
    return {
      reasons: [
        `step type "${kind}" is not available: steps that run page code, read cookies or export session data do not exist`,
      ],
    };
  }
  if (!Object.hasOwn(stepSchemas, kind)) {
    return { reasons: [`unknown step type "${kind}"`] };
  }

  const schema: z.ZodTypeAny = stepSchemas[kind as StepKind];
  const fields = (raw as Record<string, unknown>)[kind] ?? {};
  const result = schema.safeParse(fields);
  if (!result.success) {
    return { reasons: result.error.issues.map((issue) => `${kind}: ${describeIssue(issue)}`) };
  }

  const step = { kind, ...result.data } as Step;
  const { malformed } = referencedVariables(substitutableStrings(step));
  if (malformed.length > 0) {
    return { reasons: malformed.map((reference) => `${kind}: "${reference}" is not a valid variable reference`) };
  }
  return { step };
}

function describeIssue(issue: z.ZodIssue): string {
  const field = issue.path.join(".");
  if (issue.code === "unrecognized_keys") {
    const names = issue.keys.map((key) => `"${field ? `${field}.` : ""}${key}"`).join(", ");
    return `unknown field ${names}`;
  }
  if (issue.code === "invalid_type" && issue.received === "undefined") {
    return `missing required field "${field}"`;
  }
  return field ? `field "${field}": ${issue.message}` : issue.message;
}

function orderProblems(steps: Step[]): ScriptProblem[] {
  const problems: ScriptProblem[] = [];
  const firstCaptureStep = new Map<string, number>();
  steps.forEach((step, index) => {
    const name = capturedVariable(step);
    if (name !== undefined && !firstCaptureStep.has(name)) {
      firstCaptureStep.set(name, index + 1);
    }
  });

  const captured = new Set<string>();
  const started = new Set<string>();
  let hasTargetTab = false;

  steps.forEach((step, index) => {
    const number = index + 1;

    for (const name of variablesUsed(step)) {
      if (captured.has(name)) {
        continue;
      }
      const captureStep = firstCaptureStep.get(name);
      problems.push({
        step: number,
        reason:
          captureStep === undefined
            ? `variable "${name}" is never captured`
            : `variable "${name}" is used before step ${captureStep} captures it`,
      });
    }

    switch (step.kind) {
      case "open_tab":
      case "use_tab":
        hasTargetTab = true;
        break;
      case "navigate":
      case "wait_for":
      case "type":
      case "click":
      case "press_key":
      case "close_tab":
        if (!hasTargetTab) {
          problems.push({
            step: number,
            reason: `${step.kind} needs a target tab: no open_tab or use_tab step sets one before it`,
          });
        }
        if (step.kind === "close_tab") {
          hasTargetTab = false;
        }
        break;
      case "start":
        if (started.has(step.id)) {
          problems.push({ step: number, reason: `start id "${step.id}" is already used by an earlier step` });
        }
        started.add(step.id);
        break;
      case "await":
        if (!started.has(step.id)) {
          problems.push({ step: number, reason: `await of unknown id "${step.id}": no earlier start step has it` });
        }
        break;
      default:
        break;
    }

    const name = capturedVariable(step);
    if (name !== undefined) {
      captured.add(name);
    }
  });

  return problems;
}

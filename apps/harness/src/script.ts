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

const labelSchema = z.string().min(1);

const stepSchemas = {
  open_tab: z.object({ url: z.string().min(1), on_failure: onFailureSchema.optional(), label: labelSchema.optional() }).strict(),
  use_tab: z
    .object({
      url_prefix: z.string().min(1).optional(),
      url_regex: patternSchema.optional(),
      pick: z.enum(["only", "first"]).default("only"),
      activate: z.boolean().default(false),
      wait_s: z.number().nonnegative().default(3),
      open: z.string().min(1).optional(),
      on_failure: onFailureSchema.optional(),
      label: labelSchema.optional(),
    })
    .strict()
    .refine((fields) => (fields.url_prefix === undefined) !== (fields.url_regex === undefined), {
      message: 'needs exactly one of "url_prefix" and "url_regex"',
    }),
  navigate: z
    .object({
      url: z.string().min(1),
      timeout_s: secondsSchema.default(30),
      on_failure: onFailureSchema.optional(),
      label: labelSchema.optional(),
    })
    .strict(),
  reload: z
    .object({
      wait_until: z.enum(["domcontentloaded", "load"]).default("domcontentloaded"),
      timeout_s: secondsSchema.default(30),
      on_failure: onFailureSchema.optional(),
      label: labelSchema.optional(),
    })
    .strict(),
  wait_for: z
    .object({
      selector: selectorSchema,
      state: z.enum(["attached", "visible"]).default("visible"),
      timeout_s: secondsSchema.default(30),
      on_failure: selectorOnFailureSchema.optional(),
      label: labelSchema.optional(),
    })
    .strict(),
  type: z
    .object({
      selector: selectorSchema,
      text: z.string(),
      on_failure: selectorOnFailureSchema.optional(),
      label: labelSchema.optional(),
    })
    .strict(),
  click: z
    .object({ selector: selectorSchema, on_failure: selectorOnFailureSchema.optional(), label: labelSchema.optional() })
    .strict(),
  press_key: z
    .object({
      key: z.string().min(1),
      modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).default([]),
      on_failure: onFailureSchema.optional(),
      label: labelSchema.optional(),
    })
    .strict(),
  close_tab: z.object({ on_failure: onFailureSchema.optional(), label: labelSchema.optional() }).strict(),
  run: z
    .object({
      cmd: commandSchema,
      capture: variableNameSchema.optional(),
      env: envSchema.optional(),
      timeout_s: secondsSchema.default(60),
      on_failure: onFailureSchema.optional(),
      label: labelSchema.optional(),
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
      label: labelSchema.optional(),
    })
    .strict(),
  await: z
    .object({
      id: z.string().min(1),
      timeout_s: secondsSchema.default(120),
      on_failure: onFailureSchema.optional(),
      label: labelSchema.optional(),
    })
    .strict(),
  skip_if_found: z
    .object({
      selector: selectorSchema,
      to: labelSchema,
      timeout_s: secondsSchema.default(3),
      label: labelSchema.optional(),
    })
    .strict(),
  jump: z.object({ to: labelSchema, label: labelSchema.optional() }).strict(),
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
    problems.push(...labelProblems(steps));
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
      if (copy.open !== undefined) {
        copy.open = replace(copy.open);
      }
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
      return step.open === undefined ? [] : [step.open];
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

function labelProblems(steps: Step[]): ScriptProblem[] {
  const problems: ScriptProblem[] = [];
  const labelIndex = new Map<string, number>();

  steps.forEach((step, index) => {
    if (step.label === undefined) {
      return;
    }
    if (labelIndex.has(step.label)) {
      problems.push({ step: index + 1, reason: `label "${step.label}" is already used by an earlier step` });
      return;
    }
    labelIndex.set(step.label, index);
  });

  steps.forEach((step, index) => {
    if (step.kind !== "skip_if_found" && step.kind !== "jump") {
      return;
    }
    const number = index + 1;
    const targetIndex = labelIndex.get(step.to);
    if (targetIndex === undefined) {
      problems.push({ step: number, reason: `${step.kind}.to names an unknown label "${step.to}"` });
      return;
    }
    if (targetIndex <= index) {
      problems.push({
        step: number,
        reason: `${step.kind}.to names label "${step.to}", which is not later in the script (forward jumps only)`,
      });
    }
  });

  return problems;
}

const BROWSER_STEP_KINDS = new Set<StepKind>([
  "navigate",
  "reload",
  "wait_for",
  "type",
  "click",
  "press_key",
  "close_tab",
  "skip_if_found",
]);

// What is certainly true when a step starts, on every path that reaches it.
interface PathState {
  captured: Set<string>;
  started: Set<string>;
  hasTargetTab: boolean;
}

function afterStep(state: PathState, step: Step): PathState {
  const next: PathState = { captured: new Set(state.captured), started: new Set(state.started), hasTargetTab: state.hasTargetTab };
  const name = capturedVariable(step);
  if (name !== undefined) {
    next.captured.add(name);
  }
  if (step.kind === "start") {
    next.started.add(step.id);
  }
  if (step.kind === "open_tab" || step.kind === "use_tab") {
    next.hasTargetTab = true;
  }
  if (step.kind === "close_tab") {
    next.hasTargetTab = false;
  }
  return next;
}

function common(states: PathState[]): PathState | undefined {
  const [first, ...rest] = states;
  if (first === undefined) {
    return undefined;
  }
  return {
    captured: new Set([...first.captured].filter((name) => rest.every((state) => state.captured.has(name)))),
    started: new Set([...first.started].filter((id) => rest.every((state) => state.started.has(id)))),
    hasTargetTab: states.every((state) => state.hasTargetTab),
  };
}

// Jumps only go forward (labelProblems runs first), so one pass in step order sees every path
// into a step before the step itself.
function orderProblems(steps: Step[]): ScriptProblem[] {
  const problems: ScriptProblem[] = [];
  const labelIndex = new Map<string, number>();
  steps.forEach((step, index) => {
    if (step.label !== undefined) {
      labelIndex.set(step.label, index);
    }
  });

  const incoming: PathState[][] = steps.map(() => []);
  incoming[0]?.push({ captured: new Set(), started: new Set(), hasTargetTab: false });
  const capturedBefore = new Set<string>();
  const startedBefore = new Set<string>();

  steps.forEach((step, index) => {
    const number = index + 1;
    const state = common(incoming[index] ?? []);

    if (state === undefined) {
      problems.push({ step: number, reason: `${step.kind} can never run: no path reaches it after a jump` });
    } else {
      for (const name of variablesUsed(step)) {
        if (state.captured.has(name)) {
          continue;
        }
        const later = steps.findIndex((other, at) => at > index && capturedVariable(other) === name) + 1;
        problems.push({
          step: number,
          reason: capturedBefore.has(name)
            ? `variable "${name}" is not captured on every path to this step: a jump can skip the step that captures it`
            : later > 0
              ? `variable "${name}" is used before step ${later} captures it`
              : `variable "${name}" is never captured`,
        });
      }

      if (BROWSER_STEP_KINDS.has(step.kind) && !state.hasTargetTab) {
        problems.push({
          step: number,
          reason: `${step.kind} needs a target tab on every path to it: no open_tab or use_tab step sets one before it on some path`,
        });
      }

      if (step.kind === "start" && startedBefore.has(step.id)) {
        problems.push({ step: number, reason: `start id "${step.id}" is already used by an earlier step` });
      }
      if (step.kind === "await" && !state.started.has(step.id)) {
        problems.push({
          step: number,
          reason: startedBefore.has(step.id)
            ? `await of "${step.id}": its start step is not played on every path to this step`
            : `await of unknown id "${step.id}": no earlier start step has it`,
        });
      }

      const after = afterStep(state, step);
      if (step.kind === "skip_if_found" || step.kind === "jump") {
        const target = labelIndex.get(step.to);
        if (target !== undefined) {
          incoming[target]?.push(after);
        }
      }
      if (step.kind !== "jump") {
        incoming[index + 1]?.push(after);
      }
    }

    const name = capturedVariable(step);
    if (name !== undefined) {
      capturedBefore.add(name);
    }
    if (step.kind === "start") {
      startedBefore.add(step.id);
    }
  });

  return problems;
}

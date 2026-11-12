import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import { CommandFailure, type BackgroundCommand, type CommandRunner } from "./commands.js";
import {
  DaemonError,
  DaemonUnavailableError,
  InvalidParamsError,
  type DaemonClient,
  type HarnessMethod,
  type MethodParams,
  type MethodResult,
} from "./daemon-client.js";
import type { SecretMask } from "./mask.js";
import {
  formatProblem,
  substituteStep,
  variablesUsed,
  type LoadResult,
  type Script,
  type Step,
  type StepOf,
} from "./script.js";

const DEFAULT_WAIT_ROUND_MS = 2_000;
const DEFAULT_POLL_MS = 250;
const WAIT_ROUND_RETRY_CODES = new Set(["BRAVE_INTERNAL_ERROR", "BRAVE_TIMEOUT"]);

export type RunOutcome =
  | { status: "completed" }
  | { status: "step_failed"; step: number; code: string }
  | { status: "unavailable"; reason: string };

export type ResumeSignal = "resume" | "time_limit";

export interface EngineOptions {
  script: Script;
  client: DaemonClient;
  runner: CommandRunner;
  mask: SecretMask;
  output: (line: string) => void;
  reloadScript?: () => Promise<LoadResult>;
  waitForResume?: (timeLimitMs: number) => Promise<ResumeSignal>;
  waitRoundMs?: number;
  pollMs?: number;
}

export class StepFailure extends Error {
  constructor(
    readonly code: string,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "StepFailure";
  }
}

class Unavailable extends Error {}

type SelectorStep = StepOf<"wait_for"> | StepOf<"type"> | StepOf<"click">;

function isSelectorStep(step: Step): step is SelectorStep {
  return step.kind === "wait_for" || step.kind === "type" || step.kind === "click";
}

export class Engine {
  private script: Script;
  private readonly client: DaemonClient;
  private readonly runner: CommandRunner;
  private readonly mask: SecretMask;
  private readonly output: (line: string) => void;
  private readonly reloadScript: EngineOptions["reloadScript"];
  private readonly waitForResume: EngineOptions["waitForResume"];
  private readonly waitRoundMs: number;
  private readonly pollMs: number;

  private targetTab: number | undefined;
  private readonly variables = new Map<string, string>();
  private readonly background = new Map<string, BackgroundCommand>();

  constructor(options: EngineOptions) {
    this.script = options.script;
    this.client = options.client;
    this.runner = options.runner;
    this.mask = options.mask;
    this.output = options.output;
    this.reloadScript = options.reloadScript;
    this.waitForResume = options.waitForResume;
    this.waitRoundMs = options.waitRoundMs ?? DEFAULT_WAIT_ROUND_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  }

  async run(): Promise<RunOutcome> {
    try {
      let index = 0;
      while (index < this.script.steps.length) {
        const failure = await this.playStep(index);
        if (!failure) {
          index += 1;
          continue;
        }
        if (this.script.steps[index]?.on_failure?.then !== "pause") {
          return { status: "step_failed", step: index + 1, code: failure.code };
        }
        const stopped = await this.pause(index, failure);
        if (stopped) {
          return stopped;
        }
      }
      return { status: "completed" };
    } catch (error) {
      if (error instanceof Unavailable) {
        this.say(`unavailable: ${error.message}`);
        return { status: "unavailable", reason: error.message };
      }
      throw error;
    } finally {
      await this.runner.stopAll();
    }
  }

  private say(line: string): void {
    this.output(this.mask.apply(line));
  }

  private label(index: number): string {
    return `step ${index + 1}/${this.script.steps.length} ${this.script.steps[index]?.kind ?? "?"}`;
  }

  private async playStep(index: number): Promise<StepFailure | undefined> {
    const step = this.script.steps[index]!;
    const label = this.label(index);
    const startedAt = Date.now();
    this.say(`${label}: started`);

    const rounds = 1 + (step.on_failure?.retry?.times ?? 0);
    const waitMs = (step.on_failure?.retry?.wait_s ?? 0) * 1000;
    const selectors: (string | undefined)[] = isSelectorStep(step)
      ? [step.selector, ...(step.on_failure?.selectors ?? [])]
      : [undefined];

    let last = new StepFailure("NOT_ATTEMPTED");
    for (let round = 1; round <= rounds; round += 1) {
      for (const [position, selector] of selectors.entries()) {
        try {
          await this.attempt(step, selector);
          this.say(`${label}: ok (${elapsedSeconds(startedAt)} s)`);
          return undefined;
        } catch (error) {
          if (!(error instanceof StepFailure)) {
            throw error;
          }
          last = error;
          const which = position === 0 ? "" : `, alternative selector ${position}`;
          this.say(`${label}: attempt failed (${error.message}; round ${round} of ${rounds}${which})`);
        }
      }
      if (round < rounds) {
        await sleep(waitMs);
      }
    }

    this.say(`${label}: failed (${last.message}; ${elapsedSeconds(startedAt)} s)`);
    return last;
  }

  private async attempt(rawStep: Step, selector?: string): Promise<void> {
    const step = substituteStep(rawStep, (name) => {
      const value = this.variables.get(name);
      if (value === undefined) {
        throw new StepFailure("NO_VALUE", `variable "${name}" has no value`);
      }
      return value;
    });

    switch (step.kind) {
      case "open_tab":
        this.targetTab = await this.openTab(step.url);
        return;
      case "use_tab":
        this.targetTab = await this.useTab(step);
        return;
      case "navigate": {
        const result = await this.daemon("tabs.navigate", {
          tabId: this.target(),
          url: step.url,
          timeoutMs: Math.ceil(step.timeout_s * 1000),
        });
        if (result.status !== "ok") {
          throw new StepFailure("NAVIGATION_TIMEOUT");
        }
        return;
      }
      case "wait_for":
        await this.waitFor(step, selector ?? step.selector);
        return;
      case "type": {
        const result = await this.daemon("dom.type", {
          tabId: this.target(),
          selector: selector ?? step.selector,
          text: step.text,
          clearFirst: true,
        });
        if (!result.typed) {
          throw new StepFailure("NOT_TYPED");
        }
        return;
      }
      case "click": {
        const result = await this.daemon("dom.click", { tabId: this.target(), selector: selector ?? step.selector });
        if (!result.clicked) {
          throw new StepFailure("NOT_CLICKED");
        }
        return;
      }
      case "press_key": {
        const result = await this.daemon("input.pressKey", {
          tabId: this.target(),
          key: step.key,
          modifiers: step.modifiers,
        });
        if (!result.pressed) {
          throw new StepFailure("NOT_PRESSED");
        }
        return;
      }
      case "close_tab": {
        const result = await this.daemon("tabs.close", { tabId: this.target() });
        if (!result.closed) {
          throw new StepFailure("NOT_CLOSED");
        }
        this.targetTab = undefined;
        return;
      }
      case "run": {
        const captured = await this.command(() =>
          this.runner.run({
            cmd: step.cmd,
            timeoutMs: step.timeout_s * 1000,
            requireOutput: step.capture !== undefined,
            ...(step.env ? { env: step.env } : {}),
          }),
        );
        if (step.capture !== undefined) {
          this.capture(step.capture, captured);
        }
        return;
      }
      case "start": {
        const command = await this.command(() =>
          this.runner.start({
            cmd: step.cmd,
            timeoutMs: step.timeout_s * 1000,
            ...(step.env ? { env: step.env } : {}),
            ...(step.capture_match ? { pattern: step.capture_match.pattern } : {}),
          }),
        );
        this.background.set(step.id, command);
        if (step.capture_match && command.match !== undefined) {
          this.capture(step.capture_match.var, command.match);
        }
        return;
      }
      case "await": {
        const command = this.background.get(step.id);
        if (!command) {
          throw new StepFailure("NOT_STARTED", `background command "${step.id}" was not started`);
        }
        await this.command(() => command.wait(step.timeout_s * 1000));
        return;
      }
    }
  }

  private capture(name: string, value: string): void {
    this.mask.register(value);
    this.variables.set(name, value);
  }

  private target(): number {
    if (this.targetTab === undefined) {
      throw new StepFailure("NO_TARGET_TAB");
    }
    return this.targetTab;
  }

  private async openTab(url: string): Promise<number> {
    const { tabId } = await this.daemon("tabs.open", { url });
    if (tabId < 0) {
      throw new StepFailure("NO_TAB_ID");
    }
    return tabId;
  }

  private async useTab(step: StepOf<"use_tab">): Promise<number> {
    const deadline = Date.now() + step.wait_s * 1000;
    for (;;) {
      const { tabs } = await this.daemon("tabs.list", {});
      const matches = tabs.filter((tab) => tab.url.startsWith(step.url_prefix));
      if (matches.length > 1) {
        throw new StepFailure("MANY_TABS", `${matches.length} tabs match the URL prefix`);
      }
      const [match] = matches;
      if (match) {
        return match.tabId;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return this.openTab(step.open);
      }
      await sleep(Math.min(this.pollMs, remaining));
    }
  }

  private async waitFor(step: StepOf<"wait_for">, selector: string): Promise<void> {
    const deadline = Date.now() + step.timeout_s * 1000;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new StepFailure("NOT_FOUND");
      }
      const roundMs = Math.ceil(Math.min(this.waitRoundMs, remaining));
      const roundStartedAt = Date.now();
      try {
        const result = await this.daemon("dom.waitForSelector", {
          tabId: this.target(),
          selector,
          state: step.state,
          timeoutMs: roundMs,
        });
        if (result.found) {
          return;
        }
      } catch (error) {
        if (!(error instanceof StepFailure) || !WAIT_ROUND_RETRY_CODES.has(error.code)) {
          throw error;
        }
      }
      // A round that ended early must not turn the wait into a busy loop.
      const idle = Math.min(this.pollMs, roundMs - (Date.now() - roundStartedAt), deadline - Date.now());
      if (idle > 0) {
        await sleep(idle);
      }
    }
  }

  private async command<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof CommandFailure) {
        throw new StepFailure(`COMMAND_${error.kind.toUpperCase()}`, error.message);
      }
      throw error;
    }
  }

  private async daemon<M extends HarnessMethod>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    try {
      return await this.client.call(method, params);
    } catch (error) {
      if (error instanceof DaemonUnavailableError) {
        throw new Unavailable(error.message);
      }
      if (error instanceof InvalidParamsError) {
        throw new StepFailure("INVALID_PARAMETERS", error.message);
      }
      if (error instanceof DaemonError) {
        if (error.code === "BRAVE_AUTH_REQUIRED") {
          throw new Unavailable("the daemon rejected the token");
        }
        if (error.code === "BRAVE_EXTENSION_OFFLINE" && !(await this.extensionConnected())) {
          throw new Unavailable("the extension is not connected and paired");
        }
        throw new StepFailure(error.code);
      }
      throw error;
    }
  }

  private async extensionConnected(): Promise<boolean> {
    try {
      return await this.client.connected();
    } catch {
      return false;
    }
  }

  private async pause(index: number, failure: StepFailure): Promise<RunOutcome | undefined> {
    const stepNumber = index + 1;
    const failed: RunOutcome = { status: "step_failed", step: stepNumber, code: failure.code };
    if (!this.reloadScript || !this.waitForResume) {
      this.say(`step ${stepNumber}: cannot pause here; stopping`);
      return failed;
    }

    const deadline = Date.now() + this.script.pause_timeout_s * 1000;
    await this.reportPause(index, failure);

    for (;;) {
      const remaining = deadline - Date.now();
      const signal = remaining > 0 ? await this.waitForResume(remaining) : "time_limit";
      if (signal === "time_limit") {
        this.say(`pause time limit of ${this.script.pause_timeout_s} s reached; stopping`);
        return { status: "step_failed", step: stepNumber, code: "PAUSE_TIME_LIMIT" };
      }

      const reloaded = await this.reloadScript();
      if (!reloaded.ok) {
        this.say("resume refused: the script file is invalid; still paused");
        for (const problem of reloaded.problems) {
          this.say(`  ${formatProblem(problem)}`);
        }
        continue;
      }
      const stuck = reloaded.script.steps[index];
      if (!stuck || !isDeepStrictEqual(reloaded.script.steps.slice(0, index), this.script.steps.slice(0, index))) {
        this.say(`resume refused: the steps before step ${stepNumber} differ from those already played; still paused`);
        continue;
      }
      this.script = reloaded.script;

      const used = new Set(variablesUsed(stuck));
      const earlier = this.script.steps.slice(0, index);

      const stale = earlier.find(
        (step) =>
          step.kind === "start" &&
          step.capture_match !== undefined &&
          used.has(step.capture_match.var) &&
          this.background.get(step.id)?.exited !== false,
      );
      if (stale?.kind === "start") {
        this.say(
          `resume failed: step ${stepNumber} uses a value captured from background command "${stale.id}", which has exited; stopping`,
        );
        return { status: "step_failed", step: stepNumber, code: "STALE_CAPTURE" };
      }

      if (await this.refreshCaptures(earlier, used)) {
        this.say(`resumed at step ${stepNumber}`);
        return undefined;
      }
    }
  }

  private async refreshCaptures(earlier: Step[], used: Set<string>): Promise<boolean> {
    for (const [position, step] of earlier.entries()) {
      if (step.kind !== "run" || step.capture === undefined || !used.has(step.capture)) {
        continue;
      }
      this.say(`running step ${position + 1} again for a fresh value`);
      try {
        await this.attempt(step);
      } catch (error) {
        if (!(error instanceof StepFailure)) {
          throw error;
        }
        this.say(`resume refused: step ${position + 1} failed when run again (${error.message}); still paused`);
        return false;
      }
    }
    return true;
  }

  private async reportPause(index: number, failure: StepFailure): Promise<void> {
    const step = this.script.steps[index]!;
    this.say(`paused at step ${index + 1} (${step.kind}): ${failure.code}`);

    if (this.targetTab !== undefined) {
      try {
        const { tab } = await this.daemon("tabs.getInfo", { tabId: this.targetTab });
        this.say(`tab address: ${withoutQuery(tab.url)}`);
        this.say(`tab title: ${tab.title}`);
      } catch (error) {
        if (!(error instanceof StepFailure)) {
          throw error;
        }
        this.say(`tab: not available (${error.code})`);
      }
    }

    const running = [...this.background].filter(([, command]) => !command.exited).map(([id]) => id);
    this.say(`background commands still running: ${running.length > 0 ? running.join(", ") : "none"}`);
    this.say(
      `to resume: correct the script file, then send SIGUSR2 to process ${process.pid}, or press Enter when a terminal is attached (time limit ${this.script.pause_timeout_s} s)`,
    );
  }
}

function elapsedSeconds(startedAt: number): string {
  return ((Date.now() - startedAt) / 1000).toFixed(1);
}

function withoutQuery(address: string): string {
  try {
    const url = new URL(address);
    return `${url.origin}${url.pathname}`;
  } catch {
    return address.split(/[?#]/)[0] ?? "";
  }
}

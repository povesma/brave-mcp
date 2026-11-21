import { spawn, type ChildProcess } from "node:child_process";

import { TOKEN_ENV_VARIABLE } from "./daemon-client.js";

const MATCH_SETTLE_MS = 250;
const MATCH_BUFFER_CHARS = 64 * 1024;
const STOP_GRACE_MS = 2_000;

export type Command = readonly [string, ...string[]];

export type CommandFailureKind =
  | "exit"
  | "time_limit"
  | "empty_output"
  | "not_started"
  | "no_match"
  | "many_matches"
  | "exited_early";

const FAILURE_TEXT: Record<CommandFailureKind, string> = {
  exit: "the command exited with a non-zero code",
  time_limit: "the command did not finish within its time limit",
  empty_output: "the command printed nothing to capture",
  not_started: "the command could not be started",
  no_match: "the command printed no text matching the pattern within the time limit",
  many_matches: "the command printed more than one distinct text matching the pattern",
  exited_early: "the command exited before printing text matching the pattern",
};

export class CommandFailure extends Error {
  constructor(
    readonly kind: CommandFailureKind,
    readonly exitCode?: number,
  ) {
    super(kind === "exit" && exitCode !== undefined ? `the command exited with code ${exitCode}` : FAILURE_TEXT[kind]);
    this.name = "CommandFailure";
  }
}

export interface RunOptions {
  cmd: Command;
  env?: Record<string, string>;
  timeoutMs: number;
  requireOutput?: boolean;
}

export interface StartOptions {
  cmd: Command;
  env?: Record<string, string>;
  pattern?: string;
  timeoutMs: number;
}

export class BackgroundCommand {
  match: string | undefined;
  exited = false;
  private exitCode: number | null = null;
  private readonly done: Promise<void>;

  constructor(private readonly child: ChildProcess) {
    this.done = new Promise<void>((resolve) => {
      const finish = (code: number | null): void => {
        this.exited = true;
        this.exitCode = code;
        resolve();
      };
      child.once("close", (code) => finish(code));
      child.once("error", () => finish(null));
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  async wait(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeLimit = new Promise<"time_limit">((resolve) => {
      timer = setTimeout(() => resolve("time_limit"), timeoutMs);
    });
    const outcome = await Promise.race([this.done, timeLimit]);
    clearTimeout(timer);

    if (outcome === "time_limit") {
      throw new CommandFailure("time_limit");
    }
    if (this.exitCode !== 0) {
      throw new CommandFailure("exit", this.exitCode ?? undefined);
    }
  }

  async stop(): Promise<void> {
    if (this.exited) {
      return;
    }
    this.child.kill("SIGTERM");
    const forceTimer = setTimeout(() => this.child.kill("SIGKILL"), STOP_GRACE_MS);
    await this.done;
    clearTimeout(forceTimer);
  }
}

export class CommandRunner {
  private readonly background = new Set<BackgroundCommand>();
  private readonly foreground = new Set<ChildProcess>();

  constructor(private readonly baseEnv: NodeJS.ProcessEnv = process.env) {}

  run(options: RunOptions): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = this.spawn(options.cmd, options.env);
      this.foreground.add(child);
      let output = "";
      let timedOut = false;

      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
      });
      child.stderr?.resume();

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);

      child.once("error", () => {
        clearTimeout(timer);
        this.foreground.delete(child);
        reject(new CommandFailure("not_started"));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        this.foreground.delete(child);
        if (timedOut) {
          reject(new CommandFailure("time_limit"));
          return;
        }
        if (code !== 0) {
          reject(new CommandFailure("exit", code ?? undefined));
          return;
        }
        const captured = output.replace(/\r?\n$/, "");
        if (options.requireOutput && captured === "") {
          reject(new CommandFailure("empty_output"));
          return;
        }
        resolve(captured);
      });
    });
  }

  start(options: StartOptions): Promise<BackgroundCommand> {
    return new Promise<BackgroundCommand>((resolve, reject) => {
      const child = this.spawn(options.cmd, options.env);
      const command = new BackgroundCommand(child);
      this.background.add(command);

      const pattern = options.pattern === undefined ? undefined : new RegExp(options.pattern, "g");
      const buffers = { stdout: "", stderr: "" };
      let settled = false;
      let settleTimer: NodeJS.Timeout | undefined;
      let limitTimer: NodeJS.Timeout | undefined;

      const finish = (failure?: CommandFailure): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(settleTimer);
        clearTimeout(limitTimer);
        buffers.stdout = "";
        buffers.stderr = "";
        if (failure) {
          void command.stop().then(() => reject(failure));
        } else {
          resolve(command);
        }
      };

      const found = new Set<string>();

      // A match that reaches the end of the text read so far may still grow, so it is
      // recorded only once more text follows it or the stream is read for the last time.
      const scan = (stream: "stdout" | "stderr", last: boolean): boolean => {
        if (!pattern) {
          return false;
        }
        const text = buffers[stream];
        let consumed = 0;
        let sawMatch = false;
        for (const match of text.matchAll(pattern)) {
          if (match[0] === "") {
            continue;
          }
          sawMatch = true;
          const end = match.index + match[0].length;
          if (!last && end === text.length) {
            break;
          }
          found.add(match[0]);
          consumed = end;
        }
        buffers[stream] = text.slice(consumed).slice(-MATCH_BUFFER_CHARS);
        return sawMatch;
      };

      const conclude = (): void => {
        if (settled) {
          return;
        }
        scan("stdout", true);
        scan("stderr", true);
        if (found.size === 1) {
          command.match = [...found][0];
          finish();
        } else {
          finish(new CommandFailure(found.size === 0 ? "exited_early" : "many_matches"));
        }
      };

      const read = (stream: "stdout" | "stderr") => (chunk: string) => {
        if (settled || !pattern) {
          return;
        }
        buffers[stream] += chunk;
        if (scan(stream, false) && settleTimer === undefined) {
          settleTimer = setTimeout(conclude, MATCH_SETTLE_MS);
        }
      };

      child.stdout?.setEncoding("utf8").on("data", read("stdout"));
      child.stderr?.setEncoding("utf8").on("data", read("stderr"));

      child.once("error", () => finish(new CommandFailure("not_started")));
      child.once("spawn", () => {
        if (!pattern) {
          finish();
        }
      });
      child.once("close", () => {
        if (pattern) {
          conclude();
        }
      });

      if (pattern) {
        limitTimer = setTimeout(() => finish(new CommandFailure("no_match")), options.timeoutMs);
      }
    });
  }

  running(): BackgroundCommand[] {
    return [...this.background].filter((command) => !command.exited);
  }

  async stopAll(): Promise<void> {
    const foreground = [...this.foreground].map(
      (child) =>
        new Promise<void>((resolve) => {
          child.once("close", () => resolve());
          child.kill("SIGKILL");
        }),
    );
    await Promise.all([...foreground, ...this.running().map((command) => command.stop())]);
  }

  private spawn(cmd: Command, stepEnv: Record<string, string> = {}): ChildProcess {
    const [program, ...args] = cmd;
    const env: NodeJS.ProcessEnv = { ...this.baseEnv };
    delete env[TOKEN_ENV_VARIABLE];
    return spawn(program, args, {
      shell: false,
      env: { ...env, ...stepEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}

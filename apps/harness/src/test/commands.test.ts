import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CommandFailure, CommandRunner, type Command } from "../commands.js";

const CALLBACK_PATTERN = "http://127\\.0\\.0\\.1:\\d+/callback\\S*";

function standIn(name: string, ...args: string[]): Command {
  return [process.execPath, fileURLToPath(new URL(`../../fixtures/commands/${name}.mjs`, import.meta.url)), ...args];
}

function failureOf(kind: CommandFailure["kind"]): (error: unknown) => boolean {
  return (error) => error instanceof CommandFailure && error.kind === kind;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withRunner(run: (runner: CommandRunner) => Promise<void>, env = process.env): Promise<void> {
  const runner = new CommandRunner(env);
  try {
    await run(runner);
  } finally {
    await runner.stopAll();
  }
}

test("an argument with shell characters arrives as one unchanged argument", async () => {
  await withRunner(async (runner) => {
    const output = await runner.run({ cmd: standIn("print-args", "a; b $(echo x) `id`", "second"), timeoutMs: 10_000 });

    assert.equal(output, "a; b $(echo x) `id`\nsecond");
  });
});

test("standard output is returned with the trailing line break removed", async () => {
  await withRunner(async (runner) => {
    assert.equal(await runner.run({ cmd: standIn("print-value", "hello"), timeoutMs: 10_000 }), "hello");
  });
});

test("a non-zero exit is a failure that reports the exit code only", async () => {
  await withRunner(async (runner) => {
    await assert.rejects(runner.run({ cmd: standIn("exit-with", "3"), timeoutMs: 10_000 }), (error) => {
      assert.ok(error instanceof CommandFailure);
      assert.equal(error.kind, "exit");
      assert.equal(error.exitCode, 3);
      assert.doesNotMatch(error.message, /stand-in|exit-with/);
      return true;
    });
  });
});

test("the time limit ends a command", async () => {
  await withRunner(async (runner) => {
    const startedAt = Date.now();

    await assert.rejects(runner.run({ cmd: standIn("sleep", "20"), timeoutMs: 200 }), failureOf("time_limit"));

    assert.ok(Date.now() - startedAt < 5_000);
  });
});

test("an empty capture is a failure", async () => {
  await withRunner(async (runner) => {
    await assert.rejects(
      runner.run({ cmd: standIn("print-value", ""), timeoutMs: 10_000, requireOutput: true }),
      failureOf("empty_output"),
    );
  });
});

test("a program that does not exist is a failure", async () => {
  await withRunner(async (runner) => {
    await assert.rejects(runner.run({ cmd: ["brave-mcp-no-such-program"], timeoutMs: 10_000 }), failureOf("not_started"));
  });
});

test("the child environment lacks the harness token and contains the step's values", async () => {
  const env = { ...process.env, BRAVE_MCP_AUTH_TOKEN: "harness-token", INHERITED_VALUE: "kept" };
  await withRunner(async (runner) => {
    const output = await runner.run({
      cmd: standIn("print-env", "BRAVE_MCP_AUTH_TOKEN", "INHERITED_VALUE", "STEP_VALUE"),
      env: { STEP_VALUE: "from-step" },
      timeoutMs: 10_000,
    });

    assert.equal(output, "BRAVE_MCP_AUTH_TOKEN=<unset>\nINHERITED_VALUE=kept\nSTEP_VALUE=from-step");
  }, env);
});

for (const stream of ["stdout", "stderr"]) {
  test(`a background command's pattern is captured from ${stream}, and await sees it exit`, async () => {
    await withRunner(async (runner) => {
      const command = await runner.start({
        cmd: standIn("url-then-wait", "--stream", stream),
        pattern: CALLBACK_PATTERN,
        timeoutMs: 10_000,
      });

      assert.match(command.match ?? "", /^http:\/\/127\.0\.0\.1:\d+\/callback\?state=one$/);
      assert.equal(command.exited, false);

      await fetch(command.match!, { signal: AbortSignal.timeout(5_000) });
      await command.wait(10_000);

      assert.equal(command.exited, true);
    });
  });
}

test("a second distinct match is a failure", async () => {
  await withRunner(async (runner) => {
    await assert.rejects(
      runner.start({ cmd: standIn("url-then-wait", "--second-url"), pattern: CALLBACK_PATTERN, timeoutMs: 10_000 }),
      failureOf("many_matches"),
    );
  });
});

test("a background command that exits before a match is a failure", async () => {
  await withRunner(async (runner) => {
    await assert.rejects(
      runner.start({ cmd: standIn("exit-with", "0"), pattern: CALLBACK_PATTERN, timeoutMs: 10_000 }),
      failureOf("exited_early"),
    );
  });
});

test("no match within the time limit is a failure and ends the command", async () => {
  await withRunner(async (runner) => {
    await assert.rejects(
      runner.start({ cmd: standIn("sleep", "20"), pattern: CALLBACK_PATTERN, timeoutMs: 300 }),
      failureOf("no_match"),
    );

    assert.equal(runner.running().length, 0);
  });
});

test("await fails on a non-zero exit and reports the code", async () => {
  await withRunner(async (runner) => {
    const command = await runner.start({
      cmd: standIn("url-then-wait", "--exit-code", "4"),
      pattern: CALLBACK_PATTERN,
      timeoutMs: 10_000,
    });
    await fetch(command.match!, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined);

    await assert.rejects(command.wait(10_000), (error) => {
      assert.ok(error instanceof CommandFailure);
      assert.equal(error.kind, "exit");
      assert.equal(error.exitCode, 4);
      return true;
    });
  });
});

test("await fails at its own time limit while the command keeps running", async () => {
  await withRunner(async (runner) => {
    const command = await runner.start({ cmd: standIn("sleep", "20"), timeoutMs: 10_000 });

    await assert.rejects(command.wait(200), failureOf("time_limit"));

    assert.equal(command.exited, false);
  });
});

test("a background command printing a large amount of output does not block", async () => {
  await withRunner(async (runner) => {
    const command = await runner.start({
      cmd: standIn("url-then-wait", "--noise-kb", "2048"),
      pattern: CALLBACK_PATTERN,
      timeoutMs: 15_000,
    });

    await fetch(command.match!, { signal: AbortSignal.timeout(5_000) });
    await command.wait(10_000);

    assert.equal(command.exited, true);
  });
});

test("ending the runner ends its background commands", async () => {
  const runner = new CommandRunner();
  const command = await runner.start({ cmd: standIn("sleep", "60"), timeoutMs: 10_000 });
  const pid = command.pid;
  assert.ok(pid !== undefined && processIsAlive(pid));

  await runner.stopAll();

  assert.equal(command.exited, true);
  assert.equal(processIsAlive(pid), false);
});

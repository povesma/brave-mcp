import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { until } from "./entry-helpers.js";

interface Fixture {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exit: Promise<number | null>;
}

function startFixture(relativePath: string, ...args: string[]): Fixture {
  const path = fileURLToPath(new URL(`../../fixtures/${relativePath}`, import.meta.url));
  const child = spawn(process.execPath, [path, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exit = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
  return { child, stdout: () => stdout, stderr: () => stderr, exit };
}

async function page(url: string, form?: Record<string, string>): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(5_000),
    ...(form ? { method: "POST", body: new URLSearchParams(form) } : {}),
  });
  return response.text();
}

test("the fixture site shows the code field after sign-in and the success marker only for the expected values", async () => {
  const site = startFixture("site-server.mjs", "--port", "0", "--time-limit-s", "20");
  try {
    await until(() => /listening on http:\/\/127\.0\.0\.1:\d+\//.test(site.stdout()), "the fixture site to listen");
    const base = /http:\/\/127\.0\.0\.1:\d+/.exec(site.stdout())![0];

    const signIn = await page(`${base}/`);
    assert.match(signIn, /id="username"/);
    assert.match(signIn, /id="password"/);
    assert.match(signIn, /id="signin"/);

    const afterLogin = await page(`${base}/login`, { username: "fixture-user", password: "fixture-pass-9" });
    assert.match(afterLogin, /id="mfa"/);
    assert.match(afterLogin, /setTimeout/);
    assert.match(await page(`${base}/login`, { username: "fixture-user", password: "wrong" }), /id="rejected"/);

    assert.match(await page(`${base}/verify`, { code: "246810" }), /id="signed-in"/);
    assert.match(await page(`${base}/verify`, { code: "000000" }), /id="rejected"/);

    assert.match(site.stdout(), /POST \/login -> 200/);
    assert.ok(!site.stdout().includes("fixture-pass-9"), "the site must not print submitted values");
  } finally {
    site.child.kill("SIGKILL");
    await site.exit;
  }
});

test("the fixture site stops by itself at its time limit", async () => {
  const site = startFixture("site-server.mjs", "--port", "0", "--time-limit-s", "0.3");

  assert.equal(await site.exit, 0);
  assert.match(site.stdout(), /time limit reached, stopping/);
});

test("the stand-in login command prints its URL on standard error and exits 0 after the confirm callback", async () => {
  const cli = startFixture("commands/fake-cli-login.mjs", "--port", "0", "--time-limit-s", "20");
  try {
    await until(() => /authorize\?request=\w+/.test(cli.stderr()), "the stand-in login command to print its URL");
    const url = /http:\/\/127\.0\.0\.1:\d+\/authorize\?request=\w+/.exec(cli.stderr())![0];
    assert.equal(cli.stdout(), "");

    const confirmPage = await page(url);
    assert.match(confirmPage, /id="confirm"/);

    const callback = /fetch\("(\/callback\?request=\w+)"\)/.exec(confirmPage)![1];
    await page(new URL(callback!, url).href);

    assert.equal(await cli.exit, 0);
  } finally {
    cli.child.kill("SIGKILL");
    await cli.exit;
  }
});

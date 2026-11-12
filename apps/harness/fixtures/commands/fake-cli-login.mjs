// Stand-in for a command-line login that finishes in the browser.
//
//   node fixtures/commands/fake-cli-login.mjs [--port 39311] [--time-limit-s 120]
//
// Prints a sign-in URL on standard error, serves a page at that URL with a
// confirm button (#confirm) that calls the command's local callback, and exits
// 0 once the callback is hit. Exits 9 when the time limit passes first.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "39311" },
    "time-limit-s": { type: "string", default: "120" },
  },
});

const requestId = randomBytes(8).toString("hex");

const confirmPage = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture authorize</title></head><body>
<h1>Fixture authorize</h1>
<button id="confirm" type="button">Confirm</button>
<p id="state">Waiting for confirmation.</p>
<script>
  document.getElementById("confirm").addEventListener("click", async () => {
    await fetch("/callback?request=${requestId}");
    document.getElementById("state").textContent = "Confirmed.";
    document.getElementById("state").id = "done";
  });
</script>
</body></html>`;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const known = url.searchParams.get("request") === requestId;

  if (url.pathname === "/authorize" && known) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(confirmPage);
  } else if (url.pathname === "/callback" && known) {
    response.writeHead(200, { "content-type": "text/plain" }).end("ok\n", () => process.exit(0));
  } else {
    response.writeHead(404).end();
  }
});

server.listen(Number(values.port), "127.0.0.1", () => {
  const { port } = server.address();
  process.stderr.write(`Open this URL to sign in: http://127.0.0.1:${port}/authorize?request=${requestId}\n`);
});

setTimeout(() => process.exit(9), Number(values["time-limit-s"]) * 1000);

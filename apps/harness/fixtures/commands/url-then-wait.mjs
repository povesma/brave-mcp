// Stand-in for a login command: prints a local callback URL, then waits for a
// request to that URL before exiting.
//   --stream stdout|stderr   where the URL is printed (default stdout)
//   --exit-code N            exit code once the callback is hit (default 0)
//   --noise-kb N             kilobytes of other output before and after the URL
//   --second-url             print a second, different URL as well
// Exits with code 9 on its own after 30 seconds without a callback.
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    stream: { type: "string", default: "stdout" },
    "exit-code": { type: "string", default: "0" },
    "noise-kb": { type: "string", default: "0" },
    "second-url": { type: "boolean", default: false },
  },
});

const urlStream = values.stream === "stderr" ? process.stderr : process.stdout;

function writeNoise() {
  const line = `${"x".repeat(1023)}\n`;
  for (let written = 0; written < Number(values["noise-kb"]); written += 1) {
    process.stdout.write(line);
  }
}

const server = createServer((request, response) => {
  if (!request.url?.startsWith("/callback")) {
    response.writeHead(404).end();
    return;
  }
  response.end("ok\n", () => process.exit(Number(values["exit-code"])));
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  writeNoise();
  urlStream.write(`Sign in at http://127.0.0.1:${port}/callback?state=one\n`);
  if (values["second-url"]) {
    urlStream.write(`Or sign in at http://127.0.0.1:${port}/callback?state=two\n`);
  }
  writeNoise();
});

setTimeout(() => process.exit(9), 30_000);

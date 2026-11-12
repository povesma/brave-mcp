// Fixture site with the shape of a sign-in flow, for playing fixtures/login.yaml
// against a real browser.
//
//   node fixtures/site-server.mjs [--port 39310] [--time-limit-s 300] [--code-delay-ms 1500]
//
// Pages: a username and password form; after a correct sign-in, a one-time-code
// field that appears after a delay; after a correct code, a success marker
// (#signed-in). Wrong values show #rejected instead.
// Prints one line per request (method and path only, never submitted values)
// and stops on its own after the time limit.
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const EXPECTED = { username: "fixture-user", password: "fixture-pass-9", code: "246810" };

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "39310" },
    "time-limit-s": { type: "string", default: "300" },
    "code-delay-ms": { type: "string", default: "1500" },
  },
});

const startedAt = Date.now();

function log(text) {
  console.log(`[site ${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${text}`);
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
}

const signInPage = page(
  "Fixture sign-in",
  `<form method="post" action="/login">
     <label>User <input id="username" name="username" autocomplete="off"></label>
     <label>Password <input id="password" name="password" type="password"></label>
     <button id="signin" type="submit">Sign in</button>
   </form>`,
);

const codePage = page(
  "Fixture one-time code",
  `<form id="code-form" method="post" action="/verify"><p id="waiting">Preparing the code field…</p></form>
   <script>
     setTimeout(() => {
       document.getElementById("waiting").remove();
       document.getElementById("code-form").insertAdjacentHTML(
         "beforeend",
         '<label>Code <input id="mfa" name="code" autocomplete="off"></label><button id="submit" type="submit">Verify</button>',
       );
     }, ${Number(values["code-delay-ms"])});
   </script>`,
);

const successPage = page("Fixture signed in", `<p id="signed-in">Signed in.</p>`);
const rejectedPage = page("Fixture rejected", `<p id="rejected">The submitted values were not the expected ones.</p>`);

async function formFields(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  let body = page("Not found", "");
  let status = 404;

  if (request.method === "GET" && path === "/") {
    [status, body] = [200, signInPage];
  } else if (request.method === "POST" && path === "/login") {
    const fields = await formFields(request);
    const accepted = fields.get("username") === EXPECTED.username && fields.get("password") === EXPECTED.password;
    [status, body] = [200, accepted ? codePage : rejectedPage];
  } else if (request.method === "POST" && path === "/verify") {
    const fields = await formFields(request);
    [status, body] = [200, fields.get("code") === EXPECTED.code ? successPage : rejectedPage];
  }

  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
  log(`${request.method} ${path} -> ${status}`);
});

server.listen(Number(values.port), "127.0.0.1", () => {
  log(`listening on http://127.0.0.1:${server.address().port}/ — stops after ${values["time-limit-s"]} s`);
});

setTimeout(() => {
  log("time limit reached, stopping");
  process.exit(0);
}, Number(values["time-limit-s"]) * 1000);

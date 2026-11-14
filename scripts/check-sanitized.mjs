#!/usr/bin/env node
// Checks staged changes (default) or every commit (--history) for content that must not be
// published. Prints the file, commit and pattern name only, never the matched text.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const GIT_TIME_LIMIT_MS = 60_000;
const PATTERN_FILE = ".sanitize-patterns";

const BLOCKED_PATHS = [
  /(^|\/)\.env($|\.)/,
  /(^|\/)tmp\//,
  /(^|\/)local\//,
  /(^|\/)\.claude\//,
  /(^|\/)dist\//,
  /(^|\/)node_modules\//,
  /(^|\/)id_(rsa|ed25519|ecdsa)$/,
  /\.(pem|key|p12|pfx)$/,
];

const SECRET_FORMATS = [
  ["aws-access-key-id", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["github-token", /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ["openai-key", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["home-directory-path", /(\/Users\/|\/home\/)[A-Za-z0-9._-]+\//],
];

const started = Date.now();

function say(line) {
  process.stdout.write(`[check-sanitized] ${line} (${((Date.now() - started) / 1000).toFixed(1)} s)\n`);
}

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: GIT_TIME_LIMIT_MS });
  if (result.error || result.status !== 0) {
    const reason = result.error?.code === "ETIMEDOUT" ? `time limit of ${GIT_TIME_LIMIT_MS / 1000} s` : `exit ${result.status}`;
    say(`git ${args[0]} failed (${reason})`);
    process.exit(2);
  }
  return result.stdout;
}

function localPatterns(root) {
  let text;
  try {
    text = readFileSync(join(root, PATTERN_FILE), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((line, index) => ({ literal: line.trim().toLowerCase(), line: index + 1 }))
    .filter(({ literal }) => literal !== "" && !literal.startsWith("#"));
}

function contentProblems(text, patterns) {
  const found = SECRET_FORMATS.filter(([, regex]) => regex.test(text)).map(([name]) => name);
  const lower = text.toLowerCase();
  for (const { literal, line } of patterns) {
    if (lower.includes(literal)) {
      found.push(`${PATTERN_FILE} line ${line}`);
    }
  }
  return found;
}

function emailProblem(email, patterns) {
  const lower = email.toLowerCase();
  const match = patterns.find(({ literal }) => lower.includes(literal));
  return match ? `author email matches ${PATTERN_FILE} line ${match.line}` : undefined;
}

// Reads a unified diff (or `git log -p` output) and reports per commit and file.
function diffProblems(diff, patterns, problems) {
  let commit = "";
  let file = "";
  const seen = new Set();
  const report = (where, what) => {
    const line = `${where}: ${what}`;
    if (!seen.has(line)) {
      seen.add(line);
      problems.push(line);
    }
  };
  const prefix = () => (commit ? `${commit} ` : "");

  for (const line of diff.split("\n")) {
    const header = /^__COMMIT__ (\S+) (.*)$/.exec(line);
    if (header) {
      commit = header[1];
      const problem = emailProblem(header[2], patterns);
      if (problem) {
        report(commit, problem);
      }
      continue;
    }
    const path = /^diff --git a\/.* b\/(.*)$/.exec(line);
    if (path) {
      file = path[1];
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (line !== "+++ /dev/null" && BLOCKED_PATHS.some((regex) => regex.test(file))) {
        report(`${prefix()}${file}`, "blocked path");
      }
      continue;
    }
    if (line.startsWith("Binary files ") && !line.endsWith("and /dev/null differ") && BLOCKED_PATHS.some((regex) => regex.test(file))) {
      report(`${prefix()}${file}`, "blocked path");
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      for (const what of contentProblems(line.slice(1), patterns)) {
        report(`${prefix()}${file}`, what);
      }
    }
  }
}

const history = process.argv.includes("--history");
const root = git(["rev-parse", "--show-toplevel"]).trim();
const patterns = localPatterns(root);
say(`mode: ${history ? "every commit" : "staged changes"}; ${patterns.length} local pattern(s) from ${PATTERN_FILE}`);

const problems = [];
if (history) {
  say("reading every commit");
  const log = git(["log", "--all", "-p", "-U0", "--no-color", "--no-ext-diff", "--format=__COMMIT__ %h %ae"]);
  say("checking paths, added lines and author emails");
  diffProblems(log, patterns, problems);
} else {
  say("reading the author email");
  const ident = git(["var", "GIT_AUTHOR_IDENT"]);
  const email = /<([^>]*)>/.exec(ident)?.[1] ?? "";
  const problem = emailProblem(email, patterns);
  if (problem) {
    problems.push(problem);
  }
  say("reading staged changes");
  const diff = git(["diff", "--cached", "-U0", "--no-color", "--no-ext-diff", "--diff-filter=ACMR"]);
  say("checking paths and added lines");
  diffProblems(diff, patterns, problems);
}

if (problems.length === 0) {
  say("no problems found");
  process.exit(0);
}
for (const problem of problems) {
  process.stdout.write(`  ${problem}\n`);
}
say(`${problems.length} problem(s) found; nothing matched is printed`);
process.exit(1);

#!/usr/bin/env node
// Checks staged changes (default), every commit (--history), or the commits a push would send
// (--pre-push <remote-url>, ref lines on stdin as git's pre-push hook gives them) for content
// that must not be published. Prints the file, commit and pattern name only, never the matched text.
// The policy and the private terms are read from the untracked .private/ folder, so no committed file lists them.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const GIT_TIME_LIMIT_MS = 60_000;
const PATTERN_FILE = ".private/patterns";
const POLICY_FILE = ".private/policy";
const ZERO_SHA = /^0+$/;

const BLOCKED_PATHS = [
  /(^|\/)\.private\//,
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

// Reads the local policy file: "key: value" lines and "  - item" lists; any other line is ignored.
function readPolicy(root) {
  let text;
  try {
    text = readFileSync(join(root, POLICY_FILE), "utf8");
  } catch {
    return undefined;
  }
  const policy = { allowed_remotes: [], never_publish: [], author_email: undefined, upstream_base: undefined };
  let list;
  for (const line of text.split("\n")) {
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (item && list) {
      list.push(item[1].trim());
      continue;
    }
    const field = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!field) {
      continue;
    }
    list = Array.isArray(policy[field[1]]) ? policy[field[1]] : undefined;
    if (!list && field[2]) {
      policy[field[1]] = field[2].trim();
    }
  }
  return policy;
}

function globMatches(glob, value) {
  const source = glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`, "i").test(value);
}

function neverPublished(policy, file) {
  return (policy?.never_publish ?? []).some((path) => (path.endsWith("/") ? file.startsWith(path) : file === path));
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

function emailProblem(email, patterns, policy) {
  const lower = email.toLowerCase();
  const match = patterns.find(({ literal }) => lower.includes(literal));
  if (match) {
    return `author email matches ${PATTERN_FILE} line ${match.line}`;
  }
  if (policy?.author_email && !globMatches(policy.author_email, email)) {
    return `author email does not match author_email of ${POLICY_FILE}`;
  }
  return undefined;
}

// Reads a unified diff (or `git log -p` output) and reports per commit and file.
function diffProblems(diff, patterns, policy, problems) {
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
      const problem = emailProblem(header[2], patterns, policy);
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
      if (line !== "+++ /dev/null" && neverPublished(policy, file)) {
        report(`${prefix()}${file}`, "never_publish path");
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

const LOG_FORMAT = ["-p", "-U0", "--no-color", "--no-ext-diff", "--format=__COMMIT__ %h %ae"];
const prePushAt = process.argv.indexOf("--pre-push");
const mode = prePushAt >= 0 ? "pre-push" : process.argv.includes("--history") ? "history" : "staged";
const root = git(["rev-parse", "--show-toplevel"]).trim();
const patterns = localPatterns(root);
const policy = readPolicy(root);
say(
  `mode: ${mode}; ${patterns.length} local pattern(s) from ${PATTERN_FILE}; ${POLICY_FILE} ${policy ? "found" : "not found"}`,
);

const problems = [];
if (mode === "history") {
  const upstream = policy?.upstream_base ? ["--not", policy.upstream_base] : [];
  say(policy?.upstream_base ? `reading every commit not inherited from upstream_base` : "reading every commit");
  const log = git(["log", "--all", ...LOG_FORMAT, ...upstream]);
  say("checking paths, added lines and author emails");
  diffProblems(log, patterns, policy, problems);
} else if (mode === "pre-push") {
  const remoteUrl = process.argv[prePushAt + 1] ?? "";
  if (!policy) {
    problems.push(`no ${POLICY_FILE}: this repository has no local privacy policy, so nothing may be pushed`);
  } else if (!policy.allowed_remotes.includes(remoteUrl)) {
    problems.push(`the remote is not in allowed_remotes of ${POLICY_FILE}`);
  }
  say("reading the refs being pushed");
  const refs = readFileSync(0, "utf8")
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length === 4 && !ZERO_SHA.test(fields[1]));
  for (const [, localSha, , remoteSha] of refs) {
    const range = ZERO_SHA.test(remoteSha) ? [localSha, "--not", "--remotes"] : [`${remoteSha}..${localSha}`];
    say(`reading the commits not yet on the remote (${localSha.slice(0, 7)})`);
    const log = git(["log", ...LOG_FORMAT, ...range]);
    say("checking paths, added lines and author emails");
    diffProblems(log, patterns, policy, problems);
  }
} else {
  say("reading the author email");
  const ident = git(["var", "GIT_AUTHOR_IDENT"]);
  const email = /<([^>]*)>/.exec(ident)?.[1] ?? "";
  const problem = emailProblem(email, patterns, policy);
  if (problem) {
    problems.push(problem);
  }
  say("reading staged changes");
  const diff = git(["diff", "--cached", "-U0", "--no-color", "--no-ext-diff", "--diff-filter=ACMR"]);
  say("checking paths and added lines");
  diffProblems(diff, patterns, policy, problems);
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

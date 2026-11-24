import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { build } from "esbuild";

const rootDir = resolve(".");
const distDir = resolve(rootDir, "dist");
const staticDir = resolve(rootDir, "static");

if (process.argv.includes("--tests")) {
  const testDir = resolve(rootDir, "test");
  const testDistDir = resolve(rootDir, "dist-test");
  const testFiles = (await readdir(testDir)).filter((name) => name.endsWith(".test.ts"));
  await rm(testDistDir, { recursive: true, force: true });
  await build({
    entryPoints: testFiles.map((name) => resolve(testDir, name)),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outdir: testDistDir,
    outExtension: { ".js": ".mjs" },
    external: ["node:*"],
  });
  console.log(`built ${testFiles.length} test file(s) into dist-test`);
  process.exit(0);
}

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

await build({
  entryPoints: {
    background: "src/background.ts",
    options: "src/options.ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome130",
  outdir: distDir,
  sourcemap: true,
});

await cp(staticDir, distDir, { recursive: true });


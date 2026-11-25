#!/usr/bin/env node
// Checks what `npm publish` would ship, without publishing or logging in:
// - npm would not rewrite package.json (it silently dropped a "./bin/..." entry once),
// - every bin target is in the tarball, tests are not, README and LICENSE are,
// - no shipped source file is over 300 lines.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_LINES = 300;
const problems = [];
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

function npm(args, cwd) {
  return execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function checkNormalized() {
  const dir = mkdtempSync(join(tmpdir(), "pkg-fix-"));
  try {
    cpSync("package.json", join(dir, "package.json"));
    npm(["pkg", "fix"], dir);
    const fixed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (JSON.stringify(fixed) !== JSON.stringify(pkg)) {
      problems.push("npm would rewrite package.json at publish; run `npm pkg fix` and review");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkTarball() {
  const [report] = JSON.parse(npm(["pack", "--dry-run", "--json"], "."));
  const files = new Set(report.files.map((f) => f.path));
  for (const [name, target] of Object.entries(pkg.bin ?? {})) {
    if (!files.has(target)) problems.push(`bin "${name}" points at ${target}, which is not shipped`);
  }
  for (const required of ["README.md", "LICENSE", "package.json"]) {
    if (!files.has(required)) problems.push(`${required} is not shipped`);
  }
  for (const path of files) {
    if (path.startsWith("tests/") || path.startsWith("scripts/")) problems.push(`${path} is shipped`);
    if (/\.m?js$/.test(path)) {
      const lines = readFileSync(path, "utf8").split("\n").length - 1;
      if (lines > MAX_LINES) problems.push(`${path} has ${lines} lines (limit ${MAX_LINES})`);
    }
  }
  return files.size;
}

checkNormalized();
const count = checkTarball();
if (problems.length > 0) {
  for (const p of problems) console.error(`package check: ${p}`);
  process.exit(1);
}
console.log(`package check: ${count} files, bin ${JSON.stringify(pkg.bin)}, all good`);

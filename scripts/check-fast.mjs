#!/usr/bin/env node
// Standalone so the hook can bootstrap this exact runner from the Git index.
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

let temporary;
const started = performance.now();
try {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.env.INIT_CWD ?? process.cwd(),
    encoding: "utf8",
  }).trim();
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const names = (s) => s.split("\0").filter(Boolean);
  execFileSync("git", ["diff", "--cached", "--check"], {
    cwd: root,
    stdio: "inherit",
  });
  if (git("ls-files", "--unmerged"))
    throw Error("Resolve unmerged index entries first");
  const changed = names(
    git("diff", "--cached", "--no-renames", "--name-only", "-z"),
  );
  const present = new Set(names(git("ls-files", "-z")));
  const format = (changed.length ? changed : [...present]).filter((p) =>
    present.has(p),
  );
  temporary = mkdtempSync(path.join(os.tmpdir(), "lt-index-"));
  const snapshot = path.join(temporary, "tree");
  mkdirSync(snapshot);
  git("checkout-index", "--all", "--force", `--prefix=${snapshot}/`);
  // Never let Git's hook environment point fixture operations at the live index.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !k.startsWith("GIT_") &&
        !k.startsWith("NODE_TEST_") &&
        k !== "INIT_CWD",
    ),
  );
  function run(cmd, args) {
    console.log("+", cmd, ...args);
    const p = spawnSync(cmd, args, { cwd: snapshot, env, stdio: "inherit" });
    if (p.error) throw p.error;
    if (p.status !== 0) throw Error(`${cmd} exited ${p.status ?? p.signal}`);
  }
  if (!existsSync(path.join(root, "node_modules")))
    throw Error("Run npm ci before check:fast");
  symlinkSync(
    path.join(root, "node_modules"),
    path.join(snapshot, "node_modules"),
    "dir",
  );
  // Independent Git metadata lets nested tooling inspect the staged tree safely.
  run("git", ["init", "-q"]);
  run("git", ["add", "--all", "--force", "--", ...present]);
  if (format.length)
    run(process.execPath, ["scripts/check-format.mjs", ...format]);
  else console.log("Only deletions staged; no staged file bytes to format.");
  run("npm", ["run", "typecheck"]);
  run("npm", ["run", "build"]);
  const selected = new Set();
  for (const file of changed) {
    if (file === "src/index.ts" || file === "tests/index.test.ts")
      selected.add("tests/index.test.ts");
    else if (file.startsWith("src/managed/")) {
      selected.add("tests/index.test.ts");
      selected.add("tests/managed.test.ts");
    } else if (file === "tests/managed.test.ts")
      selected.add("tests/managed.test.ts");
    else {
      selected.clear();
      break;
    }
  }
  // Unknown/shared paths, empty diffs, or removed test modules select every test.
  const tests = [...present].filter((p) =>
    /^tests\/.*\.test\.(ts|mjs)$/.test(p),
  );
  const related =
    selected.size && [...selected].every((p) => present.has(p))
      ? [...selected]
      : tests;
  if (!related.length)
    throw Error("No related tests found; refusing an empty check");
  run(process.execPath, [
    "node_modules/tsx/dist/cli.mjs",
    "--test",
    ...related.sort(),
  ]);
  console.log(
    `PASS: check:fast (${((performance.now() - started) / 1000).toFixed(2)}s)`,
  );
} catch (error) {
  console.error(`check:fast failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}

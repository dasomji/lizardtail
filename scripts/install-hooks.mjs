#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import path from "node:path";
try {
  const git = (...args) =>
    execFileSync("git", args, { encoding: "utf8" }).trim();
  const root = git("rev-parse", "--show-toplevel");
  accessSync(path.join(root, ".githooks/pre-commit"), constants.X_OK);
  const setting = spawnSync("git", ["config", "--get-all", "core.hooksPath"], {
    encoding: "utf8",
  });
  if (![0, 1].includes(setting.status))
    throw Error(setting.stderr || "Cannot read hooksPath");
  const configured =
    setting.status === 0 ? setting.stdout.replace(/\n$/, "").split("\n") : [];
  if (configured.some((s) => s !== ".githooks"))
    throw Error(
      "Refusing existing core.hooksPath; integrate hooks explicitly first",
    );
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  const hooks = path.join(common, "hooks");
  const existing = existsSync(hooks)
    ? readdirSync(hooks).filter((s) => !s.endsWith(".sample"))
    : [];
  if (existing.length)
    throw Error(
      `Refusing non-sample common-directory hooks: ${existing.join(", ")}`,
    );
  const worktrees = git("worktree", "list", "--porcelain", "-z")
    .split("\0")
    .filter((s) => s.startsWith("worktree "))
    .map((s) => s.slice(9));
  const missing = worktrees.filter((p) => {
    try {
      accessSync(path.join(p, ".githooks/pre-commit"), constants.X_OK);
      return false;
    } catch {
      return true;
    }
  });
  git("config", "--local", "core.hooksPath", ".githooks");
  console.log(
    "Installed clone-wide core.hooksPath=.githooks (all linked worktrees).",
  );
  for (const p of missing)
    console.warn(
      `WARNING: L1 will not run in worktree lacking executable .githooks/pre-commit: ${p}`,
    );
} catch (error) {
  console.error(`Hook installation failed: ${error.message}`);
  process.exitCode = 1;
}

#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const root = mkdtempSync(path.join(os.tmpdir(), "lt-cli-"));
try {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !k.startsWith("GIT_") && !k.startsWith("NODE_TEST_"),
    ),
  );
  env.LIZARDTAIL_STATE_DIR = path.join(root, "state");
  env.LIZARDTAIL_HOST_CONFIG = path.join(root, "host.json");
  const run = (...args) => {
    const p = spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 10000,
    });
    if (p.error) throw p.error;
    return p;
  };
  const help = run("--help");
  assert.equal(help.status, 0, help.stdout + help.stderr);
  assert.match(help.stdout + help.stderr, /usage:/i);
  writeFileSync(
    path.join(root, "host.json"),
    JSON.stringify({ exposure: "none" }),
  );
  writeFileSync(
    path.join(root, "lizardtail.project.json"),
    JSON.stringify({ version: 999, project: "invalid" }),
  );
  const invalid = run("plan", "--instance", "invalid");
  assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
  assert.match(invalid.stderr, /Project version must be 1/);
  assert.equal(existsSync(path.join(root, "state/registry.json")), false);
  console.log(
    "PASS: CLI help and invalid-manifest refusal (no registry created)",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

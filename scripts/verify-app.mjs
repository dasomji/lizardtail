#!/usr/bin/env node
// Host-only functional rung. No real project registry, Tailnet or production changes.
import { command as runCommand } from "./verify-command.mjs";
import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const started = performance.now();
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) =>
      !k.startsWith("GIT_") && !k.startsWith("NODE_TEST_") && k !== "INIT_CWD",
  ),
);
const caddy = path.join(os.homedir(), ".local/bin/caddy");
env.CADDY_BIN = caddy;
function command(cmd, args, preflight = false) {
  return runCommand(cmd, args, { cwd: root, env, preflight });
}
try {
  if (process.platform !== "linux" || env.CI)
    throw Error(
      "preflight: verify:app runs only on the provisioned Coolify Linux host, never CI",
    );
  try {
    accessSync(caddy, constants.X_OK);
  } catch {
    throw Error("preflight: executable Caddy required at ~/.local/bin/caddy");
  }
  await command(caddy, ["version"], true);
  await command("python3", ["--version"], true);
  await command("flock", ["--version"], true);
  await command("ss", ["--version"], true);
  await command("curl", ["--version"], true);
  try {
    accessSync("/usr/lib/systemd/systemd-socket-proxyd", constants.X_OK);
  } catch {
    throw Error("preflight: systemd-socket-proxyd is required");
  }
  await command("systemctl", ["--user", "list-jobs", "--no-pager"], true);
  await command(
    "systemd-run",
    ["--user", "--wait", "--collect", "--pipe", "true"],
    true,
  );
  const options = JSON.parse(
    await command(
      "docker",
      [
        "--context",
        "rootless",
        "info",
        "--format",
        "{{json .SecurityOptions}}",
      ],
      true,
    ),
  );
  if (!Array.isArray(options) || !options.some((s) => s.includes("rootless")))
    throw Error("preflight: Docker context rootless must actually be rootless");
  // Read the same pinned image references as the maintained resource harness.
  const { readFileSync } = await import("node:fs");
  const harness = readFileSync(
    path.join(root, "scripts/smoke-resources.mjs"),
    "utf8",
  );
  const images = [...harness.matchAll(/"([^"\n]+@sha256:[a-f0-9]{64})"/g)].map(
    (m) => m[1],
  );
  if (images.length !== 2)
    throw Error("preflight: expected two pinned harness images");
  for (const image of images)
    await command(
      "docker",
      ["--context", "rootless", "image", "inspect", image],
      true,
    );
  console.log(
    "PASS: Coolify prerequisites (rootless Docker, user-systemd, Caddy, pinned images)",
  );
  console.log("+ npm run build");
  await command("npm", ["run", "build"]);
  const failures = [];
  for (const [cmd, script] of [
    ["python3", "scripts/smoke-managed.py"],
    [process.execPath, "scripts/smoke-bridge.mjs"],
    [process.execPath, "scripts/smoke-resources.mjs"],
    ["python3", "scripts/smoke-finish.py"],
  ]) {
    console.log("+", cmd, script);
    try {
      await command(cmd, [script]);
    } catch (error) {
      console.error(`${script}: ${error.message}`);
      failures.push(script);
    }
  }
  if (failures.length) throw Error(`Failed journeys: ${failures.join(", ")}`);
  console.log(
    `PASS: verify:app (${((performance.now() - started) / 1000).toFixed(2)}s); host routing only, no client ACL/tailnet proof`,
  );
} catch (error) {
  console.error(
    `verify:app failed (${((performance.now() - started) / 1000).toFixed(2)}s): ${error.message}`,
  );
  process.exitCode = 1;
}

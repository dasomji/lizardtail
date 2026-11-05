import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const runner = new URL("../scripts/verify-command.mjs", import.meta.url).href;
const driver = (code: string, options = {}) => `
  import { command } from ${JSON.stringify(runner)};
  try {
    await command(process.execPath, ["-e", ${JSON.stringify(code)}], ${JSON.stringify(options)});
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
`;

test("journey output streams before failure and stdout explains an empty-stderr failure", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lt-stream-test-"));
  const sentinel = path.join(root, "continue");
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    driver(
      `
      const { existsSync } = require("node:fs");
      console.log("journey diagnostic");
      const timer = setInterval(() => {
        if (existsSync(${JSON.stringify(sentinel)})) {
          clearInterval(timer);
          process.exit(7);
        }
      }, 10);
      `,
      { timeout: 1500, grace: 100 },
    ),
  ]);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
    if (stdout.includes("journey diagnostic")) writeFileSync(sentinel, "go");
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const status = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(status, 1);
    assert.match(stdout, /journey diagnostic/);
    // Buffered output cannot unlock the grandchild before the runner times out.
    assert.doesNotMatch(stderr, /timed out|SIGINT/);
    assert.match(stderr, /failed: journey diagnostic/);
  } finally {
    clearTimeout(watchdog);
    child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("journey timeout sends SIGINT and lets finally cleanup finish before escalation", () => {
  const p = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      driver(
        `
    let interrupt;
    const interrupted = new Promise(resolve => { interrupt = resolve; });
    process.on("SIGINT", interrupt);
    (async () => {
      try { await interrupted; }
      finally { console.log("finally cleanup complete"); }
    })();
    const timer = setInterval(() => {}, 100);
    interrupted.then(() => clearInterval(timer));
  `,
        { timeout: 500, grace: 500 },
      ),
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.ifError(p.error);
  assert.equal(p.status, 1);
  assert.match(p.stdout, /finally cleanup complete/);
  assert.match(p.stderr, /timed out.*SIGINT/);
  assert.match(
    p.stderr,
    /fixtures may be retained if cleanup did not complete/i,
  );
});

test("unresponsive journeys escalate from SIGINT through SIGTERM to SIGKILL", () => {
  const p = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      driver(
        `
    process.on("SIGINT", () => console.log("received SIGINT"));
    process.on("SIGTERM", () => console.log("received SIGTERM"));
    setInterval(() => {}, 100);
  `,
        { timeout: 500, grace: 200 },
      ),
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.ifError(p.error);
  assert.equal(p.status, 1);
  assert.match(p.stdout, /received SIGINT[\s\S]*received SIGTERM/);
  assert.match(p.stderr, /SIGKILL/);
});

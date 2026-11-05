import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyPython } from "../scripts/verify-python.mjs";

test("Python prerequisite rejects 3.10 and accepts 3.11 and 3.12 without host journeys", async () => {
  const python = spawnSync(
    "python3",
    ["-c", "import sys; print(sys.executable)"],
    {
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.ifError(python.error);
  assert.equal(python.status, 0, python.stderr);
  const root = mkdtempSync(path.join(os.tmpdir(), "lt-python-test-"));
  try {
    // Substitute only the interpreter boundary; run its probe with a controlled
    // version tuple in real Python. No verify:app runner or host journeys run.
    writeFileSync(
      path.join(root, "python3"),
      `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("Python 3." + process.env.LT_PYTHON_MINOR + ".0");
} else if (args[0] === "-c") {
  const p = spawnSync(${JSON.stringify(python.stdout.trim())}, ["-c",
    "import sys; sys.version_info = (3, " + process.env.LT_PYTHON_MINOR + ", 0); exec(sys.argv[1])", args[1]],
    { stdio: "inherit" });
  process.exit(p.status ?? 1);
} else {
  console.error("Unexpected interpreter invocation");
  process.exit(99);
}
`,
      { mode: 0o755 },
    );
    for (const minor of [10, 11, 12]) {
      const probe = verifyPython({
        cwd: root,
        env: { PATH: root, LT_PYTHON_MINOR: String(minor) },
      });
      if (minor === 10)
        await assert.rejects(probe, /preflight: Python 3\.11\+ is required/);
      else await assert.doesNotReject(probe);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

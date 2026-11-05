import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  symlinkSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const source = path.resolve(import.meta.dirname, "..");

test("resource harness reports both journey and cleanup failures with fixture retention", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lt-cleanup-test-"));
  try {
    mkdirSync(path.join(root, "scripts"));
    mkdirSync(path.join(root, "bin"));
    cpSync(path.join(source, "scripts"), path.join(root, "scripts"), {
      recursive: true,
    });
    for (const name of ["dist", "node_modules"])
      symlinkSync(path.join(source, name), path.join(root, name), "dir");
    // Substitute only executable system boundaries: no Docker/systemd host calls.
    writeFileSync(
      path.join(root, "bin/docker"),
      '#!/bin/sh\ncase "$*" in *" info "*) echo "journey sentinel" >&2;; *) echo "cleanup sentinel" >&2;; esac\nexit 1\n',
      { mode: 0o755 },
    );
    writeFileSync(path.join(root, "bin/systemctl"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    const p = spawnSync(
      process.execPath,
      [path.join(root, "scripts/smoke-resources.mjs")],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: path.join(root, "bin") + path.delimiter + process.env.PATH,
          TMPDIR: root,
        },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.ifError(p.error);
    assert.notEqual(p.status, 0);
    assert.match(p.stderr, /journey sentinel/);
    assert.match(p.stderr, /cleanup sentinel/);
    assert.match(p.stderr, /fixture retained at/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const name of ["smoke-managed.py", "smoke-finish.py"]) {
  test(`${name} preserves the journey exception and attempts both failed cleanups`, () => {
    const p = spawnSync(
      "python3",
      [
        "-c",
        `
import subprocess,runpy,sys
real_run=subprocess.run
calls=[]
def probe(cmd,*args,**kwargs):
 if cmd[0]=='node':
  cleanup='down' in cmd;calls.append('cleanup' if cleanup else 'journey')
  return subprocess.CompletedProcess(cmd,1,stdout='',stderr='cleanup sentinel' if cleanup else 'journey sentinel')
 return real_run(cmd,*args,**kwargs)
subprocess.run=probe
try:
 runpy.run_path(sys.argv[1],run_name='__main__')
except RuntimeError as error:
 assert str(error)=='journey sentinel',repr(error)
 assert error.__cause__ is None, 'cleanup must not be the cause of the journey error'
 assert any('Cleanup: ' in note and 'cleanup sentinel' in note for note in error.__notes__),repr(error.__notes__)
 assert calls==['journey','cleanup','cleanup'],calls
else:raise AssertionError('journey failure was suppressed')
`,
        path.join(source, "scripts", name),
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.ifError(p.error);
    assert.equal(p.status, 0, p.stdout + p.stderr);
  });
}

for (const name of ["smoke-bridge.mjs", "smoke-resources.mjs"]) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test(`${name} cleans once on ${signal}, repeated signals and concurrent finally`, async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "lt-signal-test-"));
      mkdirSync(path.join(root, "bin"));
      cpSync(path.join(source, "scripts"), path.join(root, "scripts"), {
        recursive: true,
      });
      for (const dir of ["dist", "node_modules"])
        symlinkSync(path.join(source, dir), path.join(root, dir), "dir");
      // Block at executable system boundaries, never call host Docker/systemd.
      const executable = String.raw`#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.LT_SIGNAL_TEST_ROOT;
const args = process.argv.slice(2);
const name = path.basename(process.argv[1]);
const waitFor = file => new Promise(resolve => {
  const timer = setInterval(() => {
    if (fs.existsSync(path.join(root, file))) { clearInterval(timer); resolve(); }
  }, 10);
});
(async () => {
  if ((name === "docker" && args.includes("info")) || args.includes("enable")) {
    fs.writeFileSync(path.join(root, "ready"), "");
    await waitFor("release-journey");
    process.exitCode = 1;
  } else if (args.includes("disable") || args.includes("stop")) {
    fs.appendFileSync(path.join(root, "cleanup-calls"), args.join(" ") + "\n");
    fs.writeFileSync(path.join(root, "cleaning"), "");
    await waitFor("release-cleanup");
  } else if (name === "docker") {
    console.error("no such object");
    process.exitCode = 1;
  }
})();
`;
      for (const bin of ["docker", "systemctl"])
        writeFileSync(path.join(root, "bin", bin), executable, { mode: 0o755 });
      const child = spawn(
        process.execPath,
        [path.join(root, "scripts", name)],
        {
          env: {
            ...process.env,
            PATH: path.join(root, "bin") + path.delimiter + process.env.PATH,
            TMPDIR: root,
            XDG_CONFIG_HOME: path.join(root, "config"),
            LT_SIGNAL_TEST_ROOT: root,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (data) => {
        output += data;
      });
      child.stderr.on("data", (data) => {
        output += data;
      });
      const closed = new Promise<{
        code: number | null;
        signal: string | null;
      }>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, signal) => resolve({ code, signal }));
      });
      const waitFor = async (file: string) => {
        const end = Date.now() + 5000;
        while (!existsSync(path.join(root, file))) {
          assert.equal(child.signalCode, null, output);
          assert.equal(child.exitCode, null, output);
          assert.ok(Date.now() < end, `waiting for ${file}: ${output}`);
          await delay(10);
        }
      };
      const watchdog = setTimeout(() => child.kill("SIGKILL"), 10000);
      try {
        await waitFor("ready");
        child.kill(signal);
        await waitFor("cleaning");
        child.kill(signal === "SIGINT" ? "SIGTERM" : "SIGINT");
        writeFileSync(path.join(root, "release-journey"), "");
        // Let the failed journey enter finally while signal cleanup is in flight.
        await delay(100);
        writeFileSync(path.join(root, "release-cleanup"), "");
        const result = await closed;
        assert.equal(result.signal, null, output);
        assert.equal(result.code, signal === "SIGINT" ? 130 : 143, output);
        const calls = readFileSync(path.join(root, "cleanup-calls"), "utf8");
        assert.equal(
          calls
            .split("\n")
            .filter((line) =>
              line.includes(name === "smoke-bridge.mjs" ? "disable" : "stop"),
            ).length,
          1,
          calls,
        );
        assert.deepEqual(
          readdirSync(root).filter((dir) => /^lt-(bridge|data)-/.test(dir)),
          [],
        );
      } finally {
        clearTimeout(watchdog);
        writeFileSync(path.join(root, "release-journey"), "");
        writeFileSync(path.join(root, "release-cleanup"), "");
        child.kill("SIGKILL");
        await closed;
        // Give any substituted executable time to consume its release sentinel.
        await delay(50);
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

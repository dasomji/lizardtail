import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const source = path.resolve(import.meta.dirname, "..");

test("resource harness reports both journey and cleanup failures with fixture retention", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lt-cleanup-test-"));
  try {
    mkdirSync(path.join(root, "scripts"));
    mkdirSync(path.join(root, "bin"));
    cpSync(
      path.join(source, "scripts/smoke-resources.mjs"),
      path.join(root, "scripts/smoke-resources.mjs"),
    );
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
 assert error.__cause__ and 'cleanup sentinel' in str(error.__cause__)
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

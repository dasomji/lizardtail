import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  cpSync,
  symlinkSync,
  rmSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const source = path.resolve(import.meta.dirname, "..");
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "lt-check-test-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !k.startsWith("GIT_") &&
        !k.startsWith("NODE_TEST_") &&
        !["INIT_CWD", "LIZARDTAIL_CHECK_ROOT"].includes(k),
    ),
  );
  env.HOME = path.join(root, "home");
  env.XDG_CONFIG_HOME = path.join(root, "home/.config");
  env.GIT_CONFIG_NOSYSTEM = "1";
  mkdirSync(env.HOME, { recursive: true });
  function run(cmd: string, args: string[], ok = true) {
    const p = spawnSync(cmd, args, {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 60000,
    });
    assert.ifError(p.error);
    if (ok) assert.equal(p.status, 0, p.stdout + p.stderr);
    return p;
  }
  const git = (...args: string[]) => run("git", args).stdout.trim();
  const write = (name: string, contents: string) => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), contents);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Lizardtail test");
  git("config", "user.email", "user@test.com");
  for (const name of ["scripts", ".githooks"]) {
    if (existsSync(path.join(source, name)))
      cpSync(path.join(source, name), path.join(root, name), {
        recursive: true,
      });
  }
  const pkg = JSON.parse(
    readFileSync(path.join(source, "package.json"), "utf8"),
  );
  write(
    "package.json",
    JSON.stringify(
      {
        type: "module",
        scripts: {
          build: "tsc -p tsconfig.json",
          typecheck: "tsc -p tsconfig.json --noEmit",
          "check:fast": pkg.scripts["check:fast"],
          "hooks:install": pkg.scripts["hooks:install"],
        },
      },
      null,
      2,
    ) + "\n",
  );
  write(
    "tsconfig.json",
    '{\n  "compilerOptions": { "outDir": "dist", "strict": true },\n  "include": ["src/**/*.ts"]\n}\n',
  );
  write(".gitignore", "node_modules\ndist/\n");
  write("src/index.ts", "export const value = 1;\n");
  write("src/managed/fixture.ts", "export const managed = 1;\n");
  write(
    "tests/index.test.ts",
    'import test from "node:test";\ntest("wrapper selection", () => {});\n',
  );
  write(
    "tests/managed.test.ts",
    'import test from "node:test";\ntest("managed selection", () => {});\n',
  );
  symlinkSync(
    path.join(source, "node_modules"),
    path.join(root, "node_modules"),
    "dir",
  );
  git("add", ".");
  git("commit", "-qm", "fixture");
  return {
    root,
    run,
    git,
    write,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("npm check:fast rejects an unformatted staged file", () => {
  const f = fixture();
  try {
    f.write("src/index.ts", "export const value=2\n");
    f.git("add", "src/index.ts");
    const p = f.run("npm", ["run", "check:fast"], false);
    assert.notEqual(p.status, 0);
    assert.match(p.stdout + p.stderr, /Code style issues|formatting/i);
  } finally {
    f.close();
  }
});

test("installed hook blocks a bad staged commit and preserves HEAD", () => {
  const f = fixture();
  try {
    f.run("npm", ["run", "hooks:install"]);
    const head = f.git("rev-parse", "HEAD");
    f.write("src/index.ts", "export const value=2\n");
    f.git("add", "src/index.ts");
    const p = f.run("git", ["commit", "-qm", "must refuse"], false);
    assert.notEqual(p.status, 0);
    assert.match(p.stdout + p.stderr, /Code style issues|formatting/i);
    assert.equal(f.git("rev-parse", "HEAD"), head);
  } finally {
    f.close();
  }
});

test("partial staging checks indexed bytes and related wrapper tests without rewriting files/index", () => {
  const f = fixture();
  try {
    f.run("npm", ["run", "hooks:install"]);
    f.write("src/index.ts", "export const value = 2;\n");
    f.git("add", "src/index.ts");
    f.write("src/index.ts", "unstaged invalid TypeScript !\n");
    f.write(
      "scripts/check-fast.mjs",
      "throw Error('unstaged runner must not execute');\n",
    );
    f.write("package.json", "broken unstaged package\n");
    const live = readFileSync(path.join(f.root, "src/index.ts"));
    const before = readFileSync(path.join(f.root, ".git/index"));
    // Invoke the installed hook as Git does, including a live index environment.
    const p = f.run("sh", [".githooks/pre-commit"]);
    assert.match(p.stdout, /wrapper selection/);
    assert.doesNotMatch(p.stdout, /managed selection/);
    assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), before);
    assert.deepEqual(readFileSync(path.join(f.root, "src/index.ts")), live);
    assert.equal(
      readFileSync(path.join(f.root, "package.json"), "utf8"),
      "broken unstaged package\n",
    );
    f.git("commit", "-qm", "staged only");
    assert.equal(f.git("show", "HEAD:src/index.ts"), "export const value = 2;");
    assert.deepEqual(readFileSync(path.join(f.root, "src/index.ts")), live);
  } finally {
    f.close();
  }
});

test("managed changes select managed tests; unknown unsupported files fail closed to all tests", () => {
  const f = fixture();
  try {
    f.write("src/managed/fixture.ts", "export const managed = 2;\n");
    f.git("add", "src/managed/fixture.ts");
    let p = f.run("npm", ["run", "check:fast"]);
    assert.match(p.stdout, /managed selection/);
    assert.doesNotMatch(p.stdout, /wrapper selection/);
    f.write("notes.txt", "unknown shared dependency\n");
    f.git("add", "notes.txt");
    // An unsupported file alone still runs typecheck/build and the entire suite.
    f.git("reset", "-q", "HEAD", "src/managed/fixture.ts");
    p = f.run("npm", ["run", "check:fast"]);
    assert.match(p.stdout, /managed selection/);
    assert.match(p.stdout, /wrapper selection/);
  } finally {
    f.close();
  }
});

test("hook installer preserves conflicting configuration and common hooks from a linked worktree", () => {
  const f = fixture();
  try {
    f.git("config", "core.hooksPath", "custom-hooks");
    let p = f.run("npm", ["run", "hooks:install"], false);
    assert.notEqual(p.status, 0);
    assert.match(p.stderr, /Refusing existing core.hooksPath/);
    assert.equal(f.git("config", "core.hooksPath"), "custom-hooks");
    f.git("config", "core.hooksPath", "");
    p = f.run("npm", ["run", "hooks:install"], false);
    assert.notEqual(
      p.status,
      0,
      "an explicitly empty hooksPath must be preserved",
    );
    assert.equal(f.git("config", "core.hooksPath"), "");
    f.git("config", "--unset", "core.hooksPath");
    f.write(".git/hooks/pre-commit", "preserve this non-executable hook\n");
    f.git("worktree", "add", "-qb", "linked", path.join(f.root, "linked"));
    p = f.run("npm", ["--prefix", "linked", "run", "hooks:install"], false);
    assert.notEqual(p.status, 0);
    assert.match(p.stderr, /non-sample common-directory hooks/);
    assert.equal(
      readFileSync(path.join(f.root, ".git/hooks/pre-commit"), "utf8"),
      "preserve this non-executable hook\n",
    );
    assert.equal(
      f.run("git", ["config", "--get", "core.hooksPath"], false).status,
      1,
    );
    rmSync(path.join(f.root, ".git/hooks/pre-commit"));
    rmSync(path.join(f.root, "linked/.githooks/pre-commit"));
    p = f.run("npm", ["run", "hooks:install"]);
    assert.match(p.stderr, /WARNING: L1 will not run.*linked/);
    f.run("npm", ["run", "hooks:install"]); // idempotent clone-wide configuration
    assert.equal(f.git("config", "--local", "core.hooksPath"), ".githooks");
  } finally {
    f.close();
  }
});

test("check:fast refuses a formatted staged type error", () => {
  const f = fixture();
  try {
    f.write("src/index.ts", 'export const value: number = "wrong";\n');
    f.git("add", "src/index.ts");
    const p = f.run("npm", ["run", "check:fast"], false);
    assert.notEqual(p.status, 0);
    assert.match(p.stdout + p.stderr, /not assignable to type 'number'/);
  } finally {
    f.close();
  }
});

test("npm check:cli exercises help and invalid-manifest refusal on this build", () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !k.startsWith("GIT_") &&
        !k.startsWith("NODE_TEST_") &&
        k !== "INIT_CWD",
    ),
  );
  const p = spawnSync("npm", ["run", "check:cli"], {
    cwd: source,
    env,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.match(p.stdout, /PASS: CLI help and invalid-manifest refusal/);
});

test("npm verify:app refuses missing Coolify prerequisites before smoke work", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lt-preflight-"));
  try {
    const env = { ...process.env, HOME: home, CI: "" };
    const p = spawnSync("npm", ["run", "verify:app"], {
      cwd: source,
      env,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.notEqual(p.status, 0);
    assert.match(p.stderr, /preflight.*caddy/i);
    assert.doesNotMatch(p.stdout, /smoke-managed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("renaming wrapper code into managed code checks both related suites", () => {
  const f = fixture();
  try {
    f.git("mv", "src/index.ts", "src/managed/renamed.ts");
    const p = f.run("npm", ["run", "check:fast"]);
    assert.match(p.stdout, /wrapper selection/);
    assert.match(p.stdout, /managed selection/);
  } finally {
    f.close();
  }
});

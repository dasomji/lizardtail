import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { DEFAULT_TIMEOUT_MS, detectLaravelViteServers, detectPortFromText, exposeWithTailscale, parseArgs, stripAnsi } from "../src/index.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "index.js");

async function writeHostCommandStubs(tempDir: string): Promise<void> {
  await writeFile(path.join(tempDir, "hostname"), "#!/usr/bin/env bash\necho test-host\n", { mode: 0o755 });
  await writeFile(
    path.join(tempDir, "docker"),
    `#!/usr/bin/env bash
if [ "$1" = "ps" ]; then
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );
}

async function writeBasicTailscaleStub(tempDir: string): Promise<string> {
  await writeHostCommandStubs(tempDir);
  const tailscalePath = path.join(tempDir, "tailscale");
  const tailscaleLog = path.join(tempDir, "tailscale.log");
  await writeFile(
    tailscalePath,
    `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TAILSCALE_LOG"
if [ "$1" = "status" ] && [ "$2" = "--json" ]; then
  echo '{"Self":{"DNSName":"test-host.tailnet.ts.net.","TailscaleIPs":["100.64.0.1"]}}'
  exit 0
fi
if [ "$1" = "status" ]; then
  echo 'ok'
  exit 0
fi
if { [ "$1" = "serve" ] || [ "$1" = "funnel" ]; } && [ "$2" = "status" ] && [ "$3" = "--json" ]; then
  echo '{}'
  exit 0
fi
if [ "$1" = "serve" ] || [ "$1" = "funnel" ]; then
  echo 'ok'
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );
  return tailscaleLog;
}

async function getFreePort(host = "127.0.0.1"): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to allocate a port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForText(read: () => string, pattern: RegExp, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(read())) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(read(), pattern);
}

function laravelViteFixtureScript(appPort: number, vitePort: number, closeAfterMs = 3_500): string {
  return `const http = require("http");
const app = http.createServer((req, res) => res.end("app"));
const vite = http.createServer((req, res) => res.end("vite"));
let ready = 0;
function onReady() {
  ready += 1;
  if (ready !== 2) return;
  console.log("[vite]   VITE v6.0.0 ready in 299 ms");
  console.log("[vite]   ➜  Local:   http://localhost:${vitePort}/");
  console.log("[server]    INFO  Server running on [http://127.0.0.1:${appPort}].");
  setTimeout(() => { app.close(); vite.close(); }, ${closeAfterMs});
}
app.listen(${appPort}, "127.0.0.1", onReady);
vite.listen(${vitePort}, "127.0.0.1", onReady);`;
}

test("detectPortFromText finds common dev-server URLs", () => {
  assert.equal(detectPortFromText("Local:   http://localhost:5173/"), 5173);
  assert.equal(detectPortFromText("ready - started server on 0.0.0.0:3000"), 3000);
  assert.equal(detectPortFromText("Server running at http://127.0.0.1:8080"), 8080);
  assert.equal(detectPortFromText("PORT=4321"), 4321);
});

test("detectPortFromText strips ANSI escape sequences", () => {
  const output = "\u001b[32mLocal:\u001b[0m http://localhost:24678";
  assert.equal(stripAnsi(output), "Local: http://localhost:24678");
  assert.equal(detectPortFromText(output), 24678);
});

test("detectPortFromText ignores invalid ports, missing ports, build durations, and in-use lines", () => {
  assert.equal(detectPortFromText("Server ready"), undefined);
  assert.equal(detectPortFromText("Local: http://localhost"), undefined);
  assert.equal(detectPortFromText("port 70000"), undefined);
  assert.equal(detectPortFromText("VITE v8.0.13 ready in 500 ms"), undefined);
  assert.equal(detectPortFromText("port 3000 is already in use"), undefined);
  assert.equal(detectPortFromText("Error: listen EADDRINUSE: address already in use http://127.0.0.1:3000"), undefined);
  assert.equal(detectPortFromText("port 3000 is already in use\nmy-server listening on http://127.0.0.1:3001"), 3001);
});

// Laravel's `composer run dev` commonly runs Vite and `php artisan serve` together.
// Prefer the app server URL over Vite's asset server when both appear in the recent output.
// Also ensure Vite's "ready in 500 ms" timing line is not mistaken for port 500.
test("detectPortFromText prefers Laravel app server output over Vite output", () => {
  const output = `[vite]   VITE v8.0.13  ready in 500 ms
[vite]   ➜  Local:   http://localhost:5174/
[server]    INFO  Server running on [http://127.0.0.1:8001].`;

  assert.equal(detectPortFromText(output), 8001);
});

test("detectLaravelViteServers finds both Laravel and Vite ports", () => {
  const output = `[vite]   VITE v8.0.13  ready in 299 ms
[vite]   ➜  Local:   http://localhost:5174/
[server]    INFO  Server running on [http://127.0.0.1:8001].`;

  assert.deepEqual(detectLaravelViteServers(output), {
    appPort: 8001,
    vitePort: 5174,
    viteHost: "localhost",
  });
});

test("detectLaravelViteServers handles Vite localhost, IPv4, and IPv6 loopback bindings", () => {
  for (const [host, expectedHost] of [
    ["localhost", "localhost"],
    ["127.0.0.1", "127.0.0.1"],
    ["[::1]", "localhost"],
  ] as const) {
    const output = `[vite]   ➜  Local:   http://${host}:5177/
[server]    INFO  Server running on [http://127.0.0.1:8002].`;

    assert.deepEqual(detectLaravelViteServers(output), {
      appPort: 8002,
      vitePort: 5177,
      viteHost: expectedHost,
    });
  }
});

test("parseArgs parses options before the command", () => {
  assert.deepEqual(parseArgs(["--host", "localhost", "--port", "3000", "--timeout=5000", "--no-open-check", "pnpm", "dev"]), {
    command: ["pnpm", "dev"],
    host: "localhost",
    port: 3000,
    timeoutMs: 5000,
    openCheck: false,
    public: false,
  });
});

test("parseArgs keeps command flags after -- delimiter", () => {
  assert.deepEqual(parseArgs(["--timeout", "1000", "--", "npm", "run", "dev", "--", "--host", "0.0.0.0"]), {
    command: ["npm", "run", "dev", "--", "--host", "0.0.0.0"],
    host: "127.0.0.1",
    timeoutMs: 1000,
    openCheck: true,
    public: false,
  });
});

test("parseArgs uses documented defaults", () => {
  assert.deepEqual(parseArgs(["pnpm", "dev"]), {
    command: ["pnpm", "dev"],
    host: "127.0.0.1",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    openCheck: true,
    public: false,
  });
});

test("parseArgs supports explicit Tailscale HTTPS ports", () => {
  assert.deepEqual(parseArgs(["--tailscale-port", "8450", "--vite-tailscale-port", "8453", "pnpm", "dev"]), {
    command: ["pnpm", "dev"],
    host: "127.0.0.1",
    tailscalePort: 8450,
    viteTailscalePort: 8453,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    openCheck: true,
    public: false,
  });
});

test("parseArgs supports public Funnel exposure", () => {
  assert.deepEqual(parseArgs(["--public", "pnpm", "dev"]), {
    command: ["pnpm", "dev"],
    host: "127.0.0.1",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    openCheck: true,
    public: true,
  });
});

test("CLI help command prints detailed documentation", async () => {
  const child = spawn(process.execPath, [cliPath, "help", "config"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve) => child.on("exit", resolve));

  assert.equal(exitCode, 0);
  assert.match(stdout, /Lizard Tail configuration/);
  assert.match(stdout, /blockedPorts/);
  assert.match(stdout, /lizardtail config init/);
});

test("CLI prints an actionable error when the command is missing from PATH", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "lizardtail-test-"));
  try {
    const child = spawn(process.execPath, [cliPath, "definitely-not-a-real-command"], {
      cwd: repoRoot,
      env: { ...process.env, PATH: tempDir },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const exitCode = await new Promise<number | null>((resolve) => child.on("exit", resolve));

    assert.equal(exitCode, 1);
    assert.match(stderr, /failed to start definitely-not-a-real-command: command not found on PATH/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("exposeWithTailscale can expose on an explicit Tailscale HTTPS port", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "lizardtail-test-"));
  await writeHostCommandStubs(tempDir);
  const tailscalePath = path.join(tempDir, "tailscale");
  const tailscaleLog = path.join(tempDir, "tailscale.log");
  const originalPath = process.env.PATH;

  await writeFile(
    tailscalePath,
    `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TAILSCALE_LOG"
if [ "$1" = "status" ] && [ "$2" = "--json" ]; then
  echo '{"Self":{"DNSName":"test-host.tailnet.ts.net."}}'
  exit 0
fi
if [ "$1" = "status" ]; then
  echo 'ok'
  exit 0
fi
if [ "$1" = "serve" ]; then
  echo 'serve ok'
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );

  try {
    process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.TAILSCALE_LOG = tailscaleLog;

    const url = await exposeWithTailscale("127.0.0.1", 3001, 8450);

    assert.equal(url, "https://test-host.tailnet.ts.net:8450");
    const calls = await readFile(tailscaleLog, "utf8");
    assert.match(calls, /serve --bg --https 8450 http:\/\/127\.0\.0\.1:3001/);
  } finally {
    process.env.PATH = originalPath;
    delete process.env.TAILSCALE_LOG;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("exposeWithTailscale can expose publicly with Tailscale Funnel", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "lizardtail-test-"));
  await writeHostCommandStubs(tempDir);
  const tailscalePath = path.join(tempDir, "tailscale");
  const tailscaleLog = path.join(tempDir, "tailscale.log");
  const originalPath = process.env.PATH;

  await writeFile(
    tailscalePath,
    `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TAILSCALE_LOG"
if [ "$1" = "status" ] && [ "$2" = "--json" ]; then
  echo '{"Self":{"DNSName":"test-host.tailnet.ts.net."}}'
  exit 0
fi
if [ "$1" = "status" ]; then
  echo 'ok'
  exit 0
fi
if [ "$1" = "serve" ] && [ "$2" = "status" ] && [ "$3" = "--json" ]; then
  echo '{}'
  exit 0
fi
if [ "$1" = "funnel" ]; then
  echo 'funnel ok'
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );

  try {
    process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.TAILSCALE_LOG = tailscaleLog;

    const url = await exposeWithTailscale("127.0.0.1", 3001, undefined, true);

    assert.equal(url, "https://test-host.tailnet.ts.net:8443");
    const calls = await readFile(tailscaleLog, "utf8");
    assert.match(calls, /funnel --bg --https 8443 http:\/\/127\.0\.0\.1:3001/);
  } finally {
    process.env.PATH = originalPath;
    delete process.env.TAILSCALE_LOG;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("exposeWithTailscale refuses Tailscale HTTPS 443", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "lizardtail-test-"));
  await writeHostCommandStubs(tempDir);
  const tailscalePath = path.join(tempDir, "tailscale");
  const tailscaleLog = path.join(tempDir, "tailscale.log");
  const originalPath = process.env.PATH;

  await writeFile(
    tailscalePath,
    `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TAILSCALE_LOG"
if [ "$1" = "status" ]; then
  echo 'ok'
  exit 0
fi
if [ "$1" = "serve" ]; then
  echo 'serve ok'
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );

  try {
    process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.TAILSCALE_LOG = tailscaleLog;

    await assert.rejects(exposeWithTailscale("127.0.0.1", 3001, 443), /refusing to use Tailscale HTTPS port 443/);

    const calls = await readFile(tailscaleLog, "utf8");
    assert.doesNotMatch(calls, /serve --bg/);
  } finally {
    process.env.PATH = originalPath;
    delete process.env.TAILSCALE_LOG;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("exposeWithTailscale respects custom blocked local ports", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "lizardtail-test-"));
  await writeHostCommandStubs(tempDir);
  const tailscaleLog = path.join(tempDir, "tailscale.log");
  const configPath = path.join(tempDir, "lizardtail.config.json");
  const originalPath = process.env.PATH;
  const originalConfig = process.env.LIZARDTAIL_CONFIG;

  await writeFile(tailscaleLog, "");
  await writeFile(
    configPath,
    JSON.stringify({ blockedPorts: [{ port: 9000, scope: "local", reason: "Reserved for my production dashboard." }] }),
  );

  try {
    process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.TAILSCALE_LOG = tailscaleLog;
    process.env.LIZARDTAIL_CONFIG = configPath;

    await assert.rejects(exposeWithTailscale("127.0.0.1", 9000, 8443), /Reserved for my production dashboard/);

    const calls = await readFile(tailscaleLog, "utf8");
    assert.doesNotMatch(calls, /serve --bg/);
  } finally {
    process.env.PATH = originalPath;
    if (originalConfig === undefined) delete process.env.LIZARDTAIL_CONFIG;
    else process.env.LIZARDTAIL_CONFIG = originalConfig;
    delete process.env.TAILSCALE_LOG;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("exposeWithTailscale skips custom blocked Tailscale HTTPS ports while auto-selecting", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "lizardtail-test-"));
  await writeHostCommandStubs(tempDir);
  const tailscalePath = path.join(tempDir, "tailscale");
  const tailscaleLog = path.join(tempDir, "tailscale.log");
  const configPath = path.join(tempDir, "lizardtail.config.json");
  const originalPath = process.env.PATH;
  const originalConfig = process.env.LIZARDTAIL_CONFIG;

  await writeFile(
    configPath,
    JSON.stringify({ blockedPorts: [{ port: 8443, scope: "tailscale", reason: "Reserved for another dev tool." }] }),
  );
  await writeFile(
    tailscalePath,
    `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TAILSCALE_LOG"
if [ "$1" = "status" ] && [ "$2" = "--json" ]; then
  echo '{"Self":{"DNSName":"test-host.tailnet.ts.net."}}'
  exit 0
fi
if [ "$1" = "status" ]; then
  echo 'ok'
  exit 0
fi
if [ "$1" = "serve" ] && [ "$2" = "status" ] && [ "$3" = "--json" ]; then
  echo '{}'
  exit 0
fi
if [ "$1" = "funnel" ] && [ "$2" = "status" ] && [ "$3" = "--json" ]; then
  echo '{}'
  exit 0
fi
if [ "$1" = "serve" ]; then
  echo 'serve ok'
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );

  try {
    process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.TAILSCALE_LOG = tailscaleLog;
    process.env.LIZARDTAIL_CONFIG = configPath;

    const url = await exposeWithTailscale("127.0.0.1", 3001);

    assert.equal(url, "https://test-host.tailnet.ts.net:8444");
    const calls = await readFile(tailscaleLog, "utf8");
    assert.match(calls, /serve --bg --https 8444 http:\/\/127\.0\.0\.1:3001/);
  } finally {
    process.env.PATH = originalPath;
    if (originalConfig === undefined) delete process.env.LIZARDTAIL_CONFIG;
    else process.env.LIZARDTAIL_CONFIG = originalConfig;
    delete process.env.TAILSCALE_LOG;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("exposeWithTailscale auto-selects a port when default HTTPS already serves another target", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "lizardtail-test-"));
  await writeHostCommandStubs(tempDir);
  const tailscalePath = path.join(tempDir, "tailscale");
  const tailscaleLog = path.join(tempDir, "tailscale.log");
  const originalPath = process.env.PATH;

  await writeFile(
    tailscalePath,
    `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TAILSCALE_LOG"
if [ "$1" = "status" ] && [ "$2" = "--json" ]; then
  echo '{"Self":{"DNSName":"test-host.tailnet.ts.net."}}'
  exit 0
fi
if [ "$1" = "status" ]; then
  echo 'ok'
  exit 0
fi
if [ "$1" = "serve" ] && [ "$2" = "status" ] && [ "$3" = "--json" ]; then
  echo '{"Web":{"test-host.tailnet.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3001"}}},"test-host.tailnet.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:5173"}}}}}'
  exit 0
fi
if [ "$1" = "serve" ]; then
  echo 'serve ok'
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );

  try {
    process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.TAILSCALE_LOG = tailscaleLog;

    const url = await exposeWithTailscale("127.0.0.1", 8001);

    assert.equal(url, "https://test-host.tailnet.ts.net:8444");
    const calls = await readFile(tailscaleLog, "utf8");
    assert.match(calls, /serve --bg --https 8444 http:\/\/127\.0\.0\.1:8001/);
  } finally {
    process.env.PATH = originalPath;
    delete process.env.TAILSCALE_LOG;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("exposeWithTailscale explains how to fix Tailscale Serve permission errors", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "lizardtail-test-"));
  await writeHostCommandStubs(tempDir);
  const tailscalePath = path.join(tempDir, "tailscale");
  const tailscaleLog = path.join(tempDir, "tailscale.log");
  const originalPath = process.env.PATH;

  await writeFile(
    tailscalePath,
    `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TAILSCALE_LOG"
if [ "$1" = "status" ]; then
  echo 'ok'
  exit 0
fi
if [ "$1" = "serve" ]; then
  echo 'sending serve config: Access denied: serve config denied' >&2
  echo "Use 'sudo tailscale serve --bg http://127.0.0.1:3001'." >&2
  echo "To not require root, use 'sudo tailscale set --operator=\$USER' once." >&2
  exit 1
fi
exit 1
`,
    { mode: 0o755 },
  );

  try {
    process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.TAILSCALE_LOG = tailscaleLog;

    await assert.rejects(
      exposeWithTailscale("127.0.0.1", 3001),
      /sudo tailscale set --operator=\$USER[\s\S]*sudo tailscale serve --bg --https 8443 http:\/\/127\.0\.0\.1:3001/,
    );

    const calls = await readFile(tailscaleLog, "utf8");
    assert.match(calls, /status/);
    assert.match(calls, /serve --bg --https 8443 http:\/\/127\.0\.0\.1:3001/);
    assert.doesNotMatch(calls, /serve --bg 3001/);
  } finally {
    process.env.PATH = originalPath;
    delete process.env.TAILSCALE_LOG;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CLI starts a command, detects its port, and calls tailscale serve", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "lizardtail-test-"));
  await writeHostCommandStubs(tempDir);
  const tailscalePath = path.join(tempDir, "tailscale");
  const tailscaleLog = path.join(tempDir, "tailscale.log");

  await writeFile(
    tailscalePath,
    `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TAILSCALE_LOG"
if [ "$1" = "status" ] && [ "$2" = "--json" ]; then
  echo '{"Self":{"DNSName":"test-host.tailnet.ts.net.","TailscaleIPs":["100.64.0.1"]}}'
  exit 0
fi
if [ "$1" = "status" ]; then
  echo 'ok'
  exit 0
fi
if [ "$1" = "serve" ]; then
  echo 'serve ok'
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );

  try {
    const child = spawn(
      process.execPath,
      [
        cliPath,
        "--timeout",
        "5000",
        "--",
        process.execPath,
        "-e",
        `const http = require("http");
const server = http.createServer((req, res) => res.end("ok"));
server.listen(0, "127.0.0.1", () => {
  console.log("Local: http://localhost:" + server.address().port);
  setTimeout(() => server.close(), 2500);
});`,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}`,
          TAILSCALE_LOG: tailscaleLog,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const exitCode = await new Promise<number | null>((resolve) => child.on("exit", resolve));

    assert.equal(exitCode, 0, `stdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.match(stdout, /Local: http:\/\/localhost:\d+/);
    assert.match(stderr, /lizardtail: detected local server on http:\/\/127\.0\.0\.1:\d+/);
    assert.match(stderr, /lizardtail: serving via Tailscale: https:\/\/test-host\.tailnet\.ts\.net/);

    const calls = await readFile(tailscaleLog, "utf8");
    assert.match(calls, /status/);
    assert.match(calls, /serve --bg --https 8443 http:\/\/127\.0\.0\.1:\d+/);
    assert.match(calls, /serve --https=8443 off/);
    assert.match(calls, /status --json/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("CLI with explicit --port still exposes a simple one-port app once", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "lizardtail-test-"));
  const tailscaleLog = await writeBasicTailscaleStub(tempDir);
  const appPort = await getFreePort();

  try {
    const child = spawn(
      process.execPath,
      [
        cliPath,
        "--port",
        String(appPort),
        "--",
        process.execPath,
        "-e",
        `const http = require("http");
const server = http.createServer((req, res) => res.end("ok"));
server.listen(${appPort}, "127.0.0.1", () => {
  console.log("app ready");
  setTimeout(() => server.close(), 2500);
});`,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}`,
          TAILSCALE_LOG: tailscaleLog,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const exitCode = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    assert.equal(exitCode, 0, stderr);
    assert.match(stderr, new RegExp(`lizardtail: detected local server on http://127\\.0\\.0\\.1:${appPort}`));
    assert.doesNotMatch(stderr, /detected Vite asset server/);

    const calls = await readFile(tailscaleLog, "utf8");
    assert.match(calls, new RegExp(`serve --bg --https 8443 http://127\\.0\\.0\\.1:${appPort}`));
    assert.doesNotMatch(calls, /serve --bg --https 8444/);
    assert.match(calls, /serve --https=8443 off/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CLI detects Laravel + Vite without --port and exposes both mappings", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "lizardtail-test-"));
  const tailscaleLog = await writeBasicTailscaleStub(tempDir);
  const appPort = await getFreePort();
  const vitePort = await getFreePort();
  await mkdir(path.join(tempDir, "public"));
  await writeFile(path.join(tempDir, "public", "hot"), "http://localhost:previous");

  try {
    const child = spawn(process.execPath, [cliPath, "--timeout", "5000", "--", process.execPath, "-e", laravelViteFixtureScript(appPort, vitePort)], {
      cwd: tempDir,
      env: {
        ...process.env,
        PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}`,
        TAILSCALE_LOG: tailscaleLog,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const exitCode = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    assert.equal(exitCode, 0, stderr);
    assert.match(stderr, new RegExp(`detected Laravel app server on http://127\\.0\\.0\\.1:${appPort}`));
    assert.match(stderr, new RegExp(`detected Vite asset server on http://localhost:${vitePort}`));
    assert.match(stderr, /serving Laravel via Tailscale: https:\/\/test-host\.tailnet\.ts\.net:8443/);
    assert.match(stderr, /serving Vite assets via Tailscale: https:\/\/test-host\.tailnet\.ts\.net:8444/);

    const calls = await readFile(tailscaleLog, "utf8");
    assert.match(calls, new RegExp(`serve --bg --https 8443 http://127\\.0\\.0\\.1:${appPort}`));
    assert.match(calls, /serve --bg --https 8444 http:\/\/127\.0\.0\.1:\d+/);
    assert.match(calls, /serve --https=8443 off/);
    assert.match(calls, /serve --https=8444 off/);
    assert.equal(await readFile(path.join(tempDir, "public", "hot"), "utf8"), "http://localhost:previous");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CLI with explicit --port still detects Laravel + Vite, writes hot file, and cleans up both mappings", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "lizardtail-test-"));
  const tailscaleLog = await writeBasicTailscaleStub(tempDir);
  const appPort = await getFreePort();
  const vitePort = await getFreePort();
  await mkdir(path.join(tempDir, "public"));
  await writeFile(path.join(tempDir, "artisan"), "#!/usr/bin/env php\n");

  try {
    const child = spawn(process.execPath, [cliPath, "--port", String(appPort), "--", process.execPath, "-e", laravelViteFixtureScript(appPort, vitePort, 4_000)], {
      cwd: tempDir,
      env: {
        ...process.env,
        PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}`,
        TAILSCALE_LOG: tailscaleLog,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    await waitForText(() => stderr, /wrote Laravel Vite hot file/);
    assert.equal(await readFile(path.join(tempDir, "public", "hot"), "utf8"), "https://test-host.tailnet.ts.net:8444");

    const exitCode = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    assert.equal(exitCode, 0, stderr);
    assert.match(stderr, new RegExp(`detected Laravel app server on http://127\\.0\\.0\\.1:${appPort}`));
    assert.match(stderr, new RegExp(`detected Vite asset server on http://localhost:${vitePort}`));
    assert.match(stderr, /restored Laravel Vite hot file/);

    await assert.rejects(readFile(path.join(tempDir, "public", "hot"), "utf8"), /ENOENT/);

    const calls = await readFile(tailscaleLog, "utf8");
    assert.match(calls, new RegExp(`serve --bg --https 8443 http://127\\.0\\.0\\.1:${appPort}`));
    assert.match(calls, /serve --bg --https 8444 http:\/\/127\.0\.0\.1:\d+/);
    assert.match(calls, /serve --https=8443 off/);
    assert.match(calls, /serve --https=8444 off/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

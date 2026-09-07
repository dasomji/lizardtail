import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  validateProject,
  expand,
  identity,
  type Project,
} from "../src/managed/config.js";
import { caddyConfig, routeAt, ownsPort } from "../src/managed/runtime.js";
import { run, registry } from "../src/managed/system.js";
import net from "node:net";
const project: Project = {
  version: 1,
  project: "demo",
  services: { web: { command: ["node", "server.js"], port: true } },
  endpoints: { app: { routes: [{ path: "/", service: "web" }] } },
};
test("rejects dependency cycles and endpoints with missing services before starting anything", () => {
  assert.throws(
    () =>
      validateProject({
        ...project,
        services: { a: { command: ["true"], dependsOn: ["a"] } },
      }),
    /Cyclic/,
  );
  assert.throws(
    () =>
      validateProject({
        ...project,
        endpoints: { app: { routes: [{ path: "/", service: "absent" }] } },
      }),
    /Invalid/,
  );
});
test("unresolved variables fail instead of leaving a default port or remote database", () => {
  assert.equal(expand("${port.web}", { "port.web": "20100" }), "20100");
  assert.throws(() => expand("${database.url}", {}), /Unresolved/);
});
test("worktree identities differ and remain stable", async () => {
  const a = await identity("/tmp/lt-a", "demo"),
    b = await identity("/tmp/lt-b", "demo");
  assert.notEqual(a.id, b.id);
  assert.deepEqual(a, await identity("/tmp/lt-a", "demo"));
});
test("port readiness rejects a foreign listener", async () => {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  try {
    const port = (s.address() as net.AddressInfo).port;
    assert.equal(await ownsPort(port, [99999999]), false);
    assert.equal(await ownsPort(port, [process.pid]), true);
  } finally {
    await new Promise<void>((r) => s.close(() => r()));
  }
});
test("Caddy routes preserve signed storage URI and explicitly strip API prefixes", () => {
  const p: any = {
    ports: { web: 20000, storage: 20001 },
    origins: {
      app: "https://app.tail.ts.net",
      storage: "https://storage.tail.ts.net",
    },
    project: {
      endpoints: {
        app: {
          routes: [
            { path: "/", service: "web" },
            { path: "/api/*", service: "web", stripPrefix: true },
          ],
        },
        storage: { routes: [{ path: "/", service: "storage" }] },
      },
    },
  };
  const cfg: any = caddyConfig(p, {
    app: "unix//tmp/a.sock",
    storage: "unix//tmp/s.sock",
  });
  assert.equal(cfg.admin.disabled, true);
  assert.equal(
    cfg.apps.http.servers.app.routes[0].handle[0].routes[0].handle[0]
      .strip_path_prefix,
    "/api",
  );
  assert.equal(
    cfg.apps.http.servers.storage.routes[0].handle[0].routes[0].handle.length,
    1,
  );
});
test("Serve ownership lookup includes named-service identity", () => {
  const p: any = {
    host: { exposure: "service" },
    names: { app: "demo" },
    origins: { app: "https://demo.tail.ts.net" },
  };
  assert.equal(
    routeAt(
      {
        Services: {
          "svc:demo": {
            Web: {
              "demo.tail.ts.net:443": {
                Handlers: { "/": { Proxy: "unix:/tmp/own" } },
              },
            },
          },
        },
      },
      p,
      "app",
    ),
    "unix:/tmp/own",
  );
  assert.equal(
    routeAt(
      {
        Web: {
          "demo.tail.ts.net:443": { Handlers: { "/": { Proxy: "foreign" } } },
        },
      },
      p,
      "app",
    ),
    undefined,
  );
});
test("concurrent plan calls allocate distinct durable ports and duplicate instances reuse them", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "lt-plan-"));
  try {
    await writeFile(
      path.join(temp, "host.json"),
      JSON.stringify({ exposure: "none", portMin: 27000, portMax: 27999 }),
    );
    await writeFile(
      path.join(temp, "lizardtail.project.json"),
      JSON.stringify(project),
    );
    const env = {
      ...process.env,
      LIZARDTAIL_STATE_DIR: path.join(temp, "state"),
      LIZARDTAIL_HOST_CONFIG: path.join(temp, "host.json"),
    };
    const cli = path.resolve("dist/index.js");
    const plans = await Promise.all(
      ["one", "two", "one"].map((n) =>
        run(process.execPath, [cli, "plan", "--instance", n], {
          cwd: temp,
          env,
        }),
      ),
    );
    const [a, b, c] = plans.map((x) => JSON.parse(x));
    assert.notEqual(a.ports.web, b.ports.web);
    assert.equal(a.ports.web, c.ports.web);
    assert.equal(a.urls.app, c.urls.app);
    if (process.platform === "linux") {
      const [portMin, portMax] = (
        await readFile("/proc/sys/net/ipv4/ip_local_port_range", "utf8")
      )
        .trim()
        .split(/\s+/)
        .map(Number);
      await writeFile(
        path.join(temp, "host.json"),
        JSON.stringify({ exposure: "none", portMin, portMax }),
      );
      await assert.rejects(
        run(process.execPath, [cli, "plan", "--instance", "ephemeral"], {
          cwd: temp,
          env,
        }),
        /Host port range exhausted/,
      );
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Service provisioning refuses foreign ownership without changing the API resource", async () => {
  const { ensureServices } = await import("../src/managed/tailscale-api.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "lt-api-"));
  const oldHost = process.env.LIZARDTAIL_HOST_CONFIG,
    original = globalThis.fetch;
  try {
    process.env.LIZARDTAIL_HOST_CONFIG = path.join(dir, "host.json");
    await writeFile(path.join(dir, "tailscale-token"), "test-token", {
      mode: 0o600,
    });
    const methods: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      return Response.json({ comment: "someone-else", ports: ["tcp:443"] });
    }) as typeof fetch;
    await assert.rejects(
      ensureServices({
        id: "owned",
        host: { exposure: "service" },
        names: { app: "example" },
      } as any),
      /not the expected/,
    );
    assert.deepEqual(methods, ["GET"]);
  } finally {
    globalThis.fetch = original;
    if (oldHost === undefined) delete process.env.LIZARDTAIL_HOST_CONFIG;
    else process.env.LIZARDTAIL_HOST_CONFIG = oldHost;
    await rm(dir, { recursive: true, force: true });
  }
});

test("port reservations include stale existing Serve targets and IPv6 listeners", async () => {
  const { portsFromServe } = await import("../src/managed/cli.js");
  assert.deepEqual(
    new Set(
      portsFromServe({
        TCP: { 8443: { HTTPS: true } },
        Web: {
          host: { Handlers: { "/": { Proxy: "http://127.0.0.1:25000" } } },
        },
        Services: {
          "svc:old": {
            Web: {
              host: { Handlers: { "/": { Proxy: "http://[::1]:25001" } } },
            },
          },
        },
      }),
    ),
    new Set([8443, 25000, 25001]),
  );
  const { free } = await import("../src/managed/system.js");
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "::1", port: 0, ipv6Only: true }, resolve);
  });
  try {
    assert.equal(await free((server.address() as net.AddressInfo).port), false);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

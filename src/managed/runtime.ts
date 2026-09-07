import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { parseEnv } from "node:util";
import { order, expand } from "./config.js";
import { run, json, atomic, free, type Plan } from "./system.js";
import { values } from "./resources.js";
import { bridgeFor, startBridge, stopBridges, type Bridge } from "./bridge.js";
export interface Runtime {
  generation: string;
  status: "starting" | "ready" | "failed" | "stopped";
  pid: number;
  endpoints: Record<string, string>;
  bridges?: Bridge[];
  error?: string;
}
export async function environment(p: Plan, service?: string) {
  const v = await values(p);
  let env: NodeJS.ProcessEnv = { ...process.env };
  delete env.LIZARDTAIL_CONFIG;
  delete env.LIZARDTAIL_STATE_DIR;
  for (const f of [
    ...(p.project.envFiles ?? []),
    ...(service ? (p.project.services[service].envFiles ?? []) : []),
  ]) {
    try {
      Object.assign(
        env,
        parseEnv(await readFile(path.resolve(p.root, f), "utf8")),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  for (const [k, x] of Object.entries({
    ...p.project.env,
    ...(service ? p.project.services[service].env : {}),
  }))
    env[k] = expand(x, { ...(env as Record<string, string>), ...v });
  env.LIZARDTAIL_MANAGED = "1";
  env.LIZARDTAIL_INSTANCE = p.instance;
  env.LIZARDTAIL_PROJECT = p.project.project;
  if (p.project.database) {
    if (p.project.database.kind === "postgres")
      env.DATABASE_URL = v["database.url"];
    else {
      env.DB_CONNECTION = "sqlite";
      env.DB_URL = "";
      env.DB_DATABASE = v["database.path"];
      env.DATABASE_URL = v["database.url"];
    }
  }
  return { env, v };
}
export async function action(p: Plan, cmd: string[], cwd?: string) {
  const { env, v } = await environment(p);
  return run(
    expand(cmd[0], v),
    cmd.slice(1).map((s) => expand(s, v)),
    { cwd: path.resolve(p.root, cwd ?? "."), env, timeout: 300000 },
  );
}
export function caddyConfig(p: Plan, sockets: Record<string, string>) {
  const servers: Record<string, unknown> = {};
  for (const [name, endpoint] of Object.entries(p.project.endpoints)) {
    const routes = [...endpoint.routes]
      .sort((a, b) => b.path.length - a.path.length)
      .map((r) => {
        const handlers: unknown[] = [];
        if (r.stripPrefix)
          handlers.push({
            handler: "rewrite",
            strip_path_prefix: r.path.slice(0, -2),
          });
        handlers.push({
          handler: "reverse_proxy",
          upstreams: [{ dial: `127.0.0.1:${p.ports[r.service]}` }],
          headers: {
            request: {
              set: {
                "X-Forwarded-Proto": [
                  new URL(p.origins[name]).protocol.slice(0, -1),
                ],
              },
            },
          },
        });
        return {
          match: r.path === "/" ? undefined : [{ path: [r.path] }],
          handle: [{ handler: "subroute", routes: [{ handle: handlers }] }],
          terminal: true,
        };
      });
    servers[name] = {
      listen: [sockets[name]],
      routes,
      automatic_https: { disable: true },
    };
  }
  return { admin: { disabled: true }, apps: { http: { servers } } };
}
export async function tailscaleStatus() {
  return JSON.parse(await run("tailscale", ["serve", "status", "--json"]));
}
export function routeAt(status: any, p: Plan, key: string): string | undefined {
  const conf =
    p.host.exposure === "service"
      ? status.Services?.["svc:" + p.names[key]]
      : status;
  return conf?.Web?.[
    new URL(p.origins[key]).host + (new URL(p.origins[key]).port ? "" : ":443")
  ]?.Handlers?.["/"]?.Proxy;
}
function tsArgs(p: Plan, key: string) {
  return p.host.exposure === "service"
    ? [`--service=svc:${p.names[key]}`, "--https=443"]
    : [`--https=${p.externalPorts[key]}`];
}
export async function removeRoutes(p: Plan, rt: Runtime) {
  if (p.host.exposure === "none") return;
  for (const [k, target] of Object.entries(rt.endpoints)) {
    const current = routeAt(await tailscaleStatus(), p, k);
    if (current === target)
      await run("tailscale", ["serve", ...tsArgs(p, k), "off"]);
    else if (current) console.error(`Leaving replaced route ${p.names[k]}`);
  }
}
async function descendants(pid: number): Promise<Set<number>> {
  const out = new Set([pid]);
  try {
    for (const s of (
      await readFile(`/proc/${pid}/task/${pid}/children`, "utf8")
    )
      .trim()
      .split(/\s+/)) {
      if (!s) continue;
      for (const n of await descendants(Number(s))) out.add(n);
    }
  } catch {}
  return out;
}
export async function ownsPort(port: number, pids: number[]) {
  const allowed = new Set<number>();
  for (const pid of pids)
    for (const n of await descendants(pid)) allowed.add(n);
  const output = await run("ss", ["-H", "-ltnp", `sport = :${port}`]);
  const owners = [...output.matchAll(/pid=(\d+)/g)].map((x) => Number(x[1]));
  return owners.length > 0 && owners.every((pid) => allowed.has(pid));
}
export async function worker(file: string) {
  const p = await json<Plan>(file);
  const children: ChildProcess[] = [];
  const servicePids: Record<string, number> = {};
  const rt: Runtime = {
    generation: randomBytes(8).toString("hex"),
    status: "starting",
    pid: process.pid,
    endpoints: {},
  };
  const rtFile = path.join(p.dir, "runtime.json");
  let stopping = false;
  let resolveStop!: () => void;
  const stopped = new Promise<void>((r) => (resolveStop = r));
  const fail = (message: string) => {
    if (stopping) return;
    rt.error = message;
    rt.status = "failed";
    void stop();
  };
  async function stop() {
    if (stopping) return;
    stopping = true;
    for (const c of children) {
      if (c.pid)
        try {
          process.kill(-c.pid, "SIGTERM");
        } catch {}
    }
    try {
      await removeRoutes(p, rt);
      await stopBridges(rt.bridges ?? []);
      rt.bridges = [];
    } catch (e) {
      rt.error = (rt.error ?? "") + "; route cleanup: " + String(e);
    }
    await new Promise((r) => setTimeout(r, 300));
    for (const c of children) {
      if (c.pid)
        try {
          process.kill(-c.pid, "SIGKILL");
        } catch {}
    }
    if (rt.status !== "failed") rt.status = "stopped";
    await atomic(rtFile, rt);
    resolveStop();
  }
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  const start = (
    cmd: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) => {
    const c = spawn(cmd, args, {
      cwd,
      env,
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
    });
    children.push(c);
    c.on("error", (e) => fail(e.message));
    c.on("exit", (code, signal) => {
      if (!stopping) fail(`${cmd} exited (${code ?? signal})`);
    });
    return c;
  };
  await atomic(rtFile, rt);
  try {
    for (const n of order(p.project)) {
      if (stopping) throw Error("Startup interrupted");
      const s = p.project.services[n];
      if (s.port && !(await free(p.ports[n])))
        throw Error(`${n}: port ${p.ports[n]} is already occupied`);
      const { env, v } = await environment(p, n);
      const c = start(
        expand(s.command[0], v),
        s.command.slice(1).map((x) => expand(x, v)),
        path.resolve(p.root, s.cwd ?? "."),
        env,
      );
      if (c.pid) servicePids[n] = c.pid;
      if (s.port) {
        const end = Date.now() + (s.ready?.timeoutMs ?? 60000);
        for (;;) {
          if (stopping) throw Error(`${n} stopped during startup`);
          try {
            if (!(await ownsPort(p.ports[n], [c.pid!])))
              throw Error("Listener is not owned by this process");
            const response = await fetch(
              `http://127.0.0.1:${p.ports[n]}${s.ready?.path ?? "/"}`,
              { signal: AbortSignal.timeout(1500), redirect: "manual" },
            );
            if (response.status !== (s.ready?.status ?? 200))
              throw Error(`HTTP ${response.status}`);
            break;
          } catch (e) {
            if (Date.now() > end) throw Error(`${n} not ready: ${String(e)}`);
            await new Promise((r) => setTimeout(r, 250));
          }
        }
      }
    }
    const sockets: Record<string, string> = {};
    rt.bridges = [];
    for (const k of Object.keys(p.project.endpoints)) {
      const socket = path.join(p.dir, `${k}-${rt.generation}.sock`);
      if (Buffer.byteLength(socket) > 100)
        throw Error(
          "State directory too long for Unix sockets; set LIZARDTAIL_STATE_DIR to a shorter path",
        );
      sockets[k] =
        p.host.exposure === "none"
          ? `127.0.0.1:${p.ports["gateway-" + k]}`
          : `unix/${socket}`;
      rt.endpoints[k] = `http://127.0.0.1:${p.ports["gateway-" + k]}`;
      if (p.host.exposure !== "none")
        rt.bridges.push(bridgeFor(p, k, rt.generation, socket));
    }
    await atomic(rtFile, rt);
    const cfg = path.join(p.dir, "caddy.json");
    await atomic(cfg, caddyConfig(p, sockets));
    await run(p.host.caddy, ["validate", "--config", cfg]);
    start(p.host.caddy, ["run", "--config", cfg], p.root, {
      ...process.env,
      XDG_CONFIG_HOME: path.join(p.dir, "caddy-config"),
      XDG_DATA_HOME: path.join(p.dir, "caddy-data"),
    });
    for (const b of rt.bridges) await startBridge(b);
    for (const k of Object.keys(sockets)) {
      const target = rt.endpoints[k];
      for (let i = 0; ; i++) {
        if (stopping) throw Error("Proxy stopped");
        try {
          await run(
            "curl",
            target.startsWith("unix:")
              ? [
                  "--silent",
                  "--show-error",
                  "--max-time",
                  "2",
                  "--unix-socket",
                  target.slice(5),
                  "http://localhost/",
                ]
              : ["--silent", "--show-error", "--max-time", "2", target],
          );
          break;
        } catch (e) {
          if (i === 30) throw e;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      if (p.host.exposure !== "none") {
        const current = routeAt(await tailscaleStatus(), p, k);
        if (current && current !== target)
          throw Error(
            `Route ${p.names[k]} is already configured; use doctor to reconcile it`,
          );
        await run("tailscale", ["serve", "--bg", ...tsArgs(p, k), target]);
        if (routeAt(await tailscaleStatus(), p, k) !== target)
          throw Error("Tailscale route verification failed");
        if (p.host.exposure === "service") {
          for (let attempt = 0; ; attempt++) {
            const status = JSON.parse(
              await run("tailscale", ["status", "--json"]),
            );
            const hosts = status.Self?.CapMap?.["service-host"] ?? [];
            if (
              hosts.some(
                (entry: Record<string, unknown>) => entry["svc:" + p.names[k]],
              )
            )
              break;
            if (attempt === 59)
              throw Error(
                `Service ${p.names[k]} advertisement not approved; check tag autoApprovers`,
              );
            await new Promise((r) => setTimeout(r, 500));
          }
        }
      }
    }
    if (stopping) throw Error("Startup interrupted");
    rt.status = "ready";
    await atomic(rtFile, rt);
    console.log(
      JSON.stringify({
        status: "ready",
        instance: p.instance,
        urls: p.origins,
      }),
    );
    let checking = false;
    const unhealthy = new Map<string, number>();
    const timer = setInterval(async () => {
      if (stopping || checking) return;
      checking = true;
      try {
        for (const [n, s] of Object.entries(p.project.services)) {
          if (
            s.port &&
            !(await ownsPort(
              p.ports[n],
              servicePids[n] ? [servicePids[n]] : [],
            ).catch(() => false))
          ) {
            fail(`${n}: listener ownership lost`);
            break;
          }
          if (s.port) {
            try {
              const response = await fetch(
                `http://127.0.0.1:${p.ports[n]}${s.ready?.path ?? "/"}`,
                { signal: AbortSignal.timeout(1500), redirect: "manual" },
              );
              await response.body?.cancel();
              if (response.status !== (s.ready?.status ?? 200))
                throw Error(`HTTP ${response.status}`);
              unhealthy.delete(n);
            } catch {
              const since = unhealthy.get(n) ?? Date.now();
              unhealthy.set(n, since);
              if (Date.now() - since > 30000) {
                fail(`${n}: HTTP readiness lost for 30 seconds`);
                break;
              }
            }
          }
        }
      } finally {
        checking = false;
      }
    }, 2000);
    await stopped;
    clearInterval(timer);
  } catch (e) {
    rt.status = "failed";
    rt.error = String(e);
    console.error(rt.error);
    await stop();
  }
  if (rt.status === "failed") process.exitCode = 1;
}

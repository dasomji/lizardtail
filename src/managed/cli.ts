import path from "node:path";
import { createHash } from "node:crypto";
import { ensureServices, deleteServices } from "./tailscale-api.js";
import { importDump } from "./resources.js";
import { stopBridges } from "./bridge.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { projectAt, identity, assertName, type Project } from "./config.js";
import {
  stateHome,
  host,
  registry,
  save,
  atomic,
  run,
  free,
  alive,
  exists,
  json,
  withLock,
  type Plan,
} from "./system.js";
import {
  action,
  worker,
  removeRoutes,
  tailscaleStatus,
  routeAt,
  type Runtime,
} from "./runtime.js";
import {
  startDatabase,
  startStorage,
  stopResources,
  markDatabase,
  importDatabase,
  dumpDatabase,
  rootless,
  values,
} from "./resources.js";
const entry = fileURLToPath(new URL("../index.js", import.meta.url));
export function portsFromServe(status: any): number[] {
  const ports = new Set<number>();
  const visit = (value: any) => {
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(value.TCP ?? {}))
      if (/^\d+$/.test(key)) ports.add(Number(key));
    if (typeof value.Proxy === "string")
      try {
        const url = new URL(value.Proxy);
        if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
          ports.add(Number(url.port || (url.protocol === "https:" ? 443 : 80)));
      } catch {}
    for (const child of Object.values(value)) visit(child);
  };
  visit(status);
  return [...ports];
}
export async function plan(cwd: string, instance?: string): Promise<Plan> {
  const { root, project } = await projectAt(cwd);
  const r = await registry();
  if (!instance)
    instance = Object.values(r.instances).find(
      (x) => x.root === root && x.project.project === project.project,
    )?.instance;
  const key = await identity(root, project.project, instance);
  const prev = r.instances[key.id];
  if (prev && prev.root !== root)
    throw Error(`Instance ${key.instance} belongs to ${prev.root}`);
  const h = await host();
  const occupied = new Set(
    Object.values(r.instances).flatMap((p) => [
      ...Object.values(p.ports),
      ...Object.values(p.externalPorts),
    ]),
  );
  for (const b of h.blockedPorts) occupied.add(b);
  // Outbound connections can claim these between the bind probe and Docker start.
  try {
    const [low, high] = (
      await readFile("/proc/sys/net/ipv4/ip_local_port_range", "utf8")
    )
      .trim()
      .split(/\s+/)
      .map(Number);
    for (let n = low; n <= high; n++) occupied.add(n);
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  if (h.exposure !== "none")
    for (const port of portsFromServe(await tailscaleStatus()))
      occupied.add(port);
  const allocate = async () => {
    for (let n = h.portMin; n <= h.portMax; n++)
      if (!occupied.has(n) && (await free(n))) {
        occupied.add(n);
        return n;
      }
    throw Error("Host port range exhausted");
  };
  const p: Plan = {
    ...key,
    root,
    project,
    host: h,
    ports: { ...prev?.ports },
    origins: {},
    names: {},
    externalPorts: { ...prev?.externalPorts },
    dir: path.join(stateHome(), "i", key.id),
    unit: `lizardtail-${key.id}.service`,
    createdAt: prev?.createdAt ?? new Date().toISOString(),
  };
  const portKeys = Object.entries(project.services)
    .filter(([, s]) => s.port)
    .map(([k]) => k);
  if (project.database?.kind === "postgres") portKeys.push("db");
  if (project.storage) portKeys.push("storage");
  portKeys.push(...Object.keys(project.endpoints).map((k) => "gateway-" + k));
  for (const n of portKeys) {
    p.ports[n] ??= await allocate();
    if (h.blockedPorts.includes(p.ports[n]))
      throw Error(`${n}: reserved port is blocked by current host policy`);
  }
  let dns = "";
  if (h.exposure !== "none") {
    if (h.tailnet && h.exposure === "service") dns = h.tailnet;
    else {
      const ts = JSON.parse(await run("tailscale", ["status", "--json"]));
      dns = ts.Self?.DNSName?.replace(/\.$/, "") ?? "";
      if (!dns) throw Error("Tailscale DNS unavailable");
    }
  }
  for (const k of Object.keys(project.endpoints)) {
    p.names[k] =
      `${project.project.slice(0, 18)}-${key.instance.slice(0, 20)}-${k.slice(0, 12)}-${createHash(
        "sha256",
      )
        .update(key.id + ":" + k)
        .digest("hex")
        .slice(0, 8)}`;
    if (h.exposure === "service") {
      const tail = h.tailnet ?? dns.slice(dns.indexOf(".") + 1);
      p.origins[k] = `https://${p.names[k]}.${tail}`;
    } else if (h.exposure === "port") {
      p.externalPorts[k] ??= await allocate();
      p.origins[k] = `https://${dns}:${p.externalPorts[k]}`;
    } else p.origins[k] = `http://127.0.0.1:${p.ports["gateway-" + k]}`;
  }
  if (prev && (await alive(prev.unit))) {
    if (
      JSON.stringify(prev.project) !== JSON.stringify(project) ||
      JSON.stringify(prev.host) !== JSON.stringify(h)
    )
      throw Error("Running configuration changed; down before applying it");
    return prev;
  }
  await mkdir(p.dir, { recursive: true, mode: 0o700 });
  r.instances[p.id] = p;
  await save(r);
  return p;
}
async function current(cwd: string, instance?: string) {
  const { root, project } = await projectAt(cwd);
  const r = await registry();
  if (!instance)
    instance = Object.values(r.instances).find(
      (x) => x.root === root && x.project.project === project.project,
    )?.instance;
  const key = await identity(root, project.project, instance);
  const p = r.instances[key.id];
  if (!p || p.root !== root)
    throw Error("Instance not registered; run plan first");
  return p;
}
export async function doctor(p?: Plan) {
  const checks: Record<string, { ok: boolean; detail: string }> = {};
  const check = async (n: string, fn: () => Promise<string>) => {
    try {
      checks[n] = { ok: true, detail: await fn() };
    } catch (e) {
      checks[n] = { ok: false, detail: String(e) };
    }
  };
  for (const [n, args] of [
    ["systemctl", ["--user", "list-jobs", "--no-pager"]],
    ["ss", ["--version"]],
    ["flock", ["--version"]],
  ] as [string, string[]][])
    await check(n, () => run(n, args));
  if (p && p.host.exposure !== "none")
    await check("socketProxy", async () => {
      await run("test", ["-x", "/usr/lib/systemd/systemd-socket-proxyd"]);
      return "systemd socket proxy available";
    });
  await check("caddy", async () =>
    run(p?.host.caddy ?? (await host()).caddy, ["version"]),
  );
  if (p && (p.project.database?.kind === "postgres" || p.project.storage))
    await check("rootlessDocker", async () => {
      await rootless(p);
      return "rootless Docker ready";
    });
  if (p && p.host.exposure !== "none")
    await check("tailscale", async () => {
      const s = JSON.parse(await run("tailscale", ["status", "--json"]));
      if (s.BackendState !== "Running") throw Error("Tailscale is not Running");
      if (p.host.exposure === "service" && !s.Self?.Tags?.length)
        throw Error(
          "Named services require a tagged host. Prepare host identity and ACLs; do not retag an SSH host blindly.",
        );
      return "ready; service definitions and advertisement approval must also exist";
    });
  return checks;
}
export async function down(p: Plan) {
  await run("systemctl", ["--user", "stop", p.unit]).catch(async (e) => {
    if (await alive(p.unit)) throw e;
  });
  const rt = await json<Runtime | undefined>(
    path.join(p.dir, "runtime.json"),
    undefined,
  ).catch(() => undefined);
  if (rt) {
    await removeRoutes(p, rt);
    await stopBridges(rt.bridges ?? []);
  }
  await stopResources(p);
}
export async function up(p: Plan) {
  const finished = await json<{ stage?: string }>(
    path.join(p.dir, "finish.json"),
    {},
  );
  if (finished.stage === "cleaned")
    throw Error("Instance was finished; create a new --instance for new work");
  if (await alive(p.unit)) {
    const rt = await json<Runtime>(path.join(p.dir, "runtime.json"));
    if (rt.status === "ready") return;
    throw Error(`Instance is ${rt.status}; inspect logs before restarting`);
  }
  const d = await doctor(p);
  const failed = Object.entries(d).filter(([, v]) => !v.ok);
  if (failed.length)
    throw Error(failed.map(([k, v]) => `${k}: ${v.detail}`).join("\n"));
  const old = await json<Runtime | null>(
    path.join(p.dir, "runtime.json"),
    null,
  );
  if (old) {
    await removeRoutes(p, old);
    await stopBridges(old.bridges ?? []);
  }
  try {
    await ensureServices(p);
    await startDatabase(p);
    if (p.project.database) {
      if (
        p.instance === "main" &&
        p.project.database.source === "import" &&
        !(await exists(path.join(p.dir, "database.ready")))
      )
        throw Error("Main requires db import before starting");
      await action(p, p.project.database.migrate, p.project.database.cwd);
      await markDatabase(p);
    }
    await startStorage(p);
    const file = path.join(p.dir, "plan.json");
    await atomic(file, p);
    await atomic(path.join(p.dir, "runtime.json"), {
      status: "starting",
      pid: 0,
      generation: "pending",
      endpoints: {},
    });
    await run("systemd-run", [
      "--user",
      "--collect",
      `--unit=${p.unit}`,
      "--service-type=exec",
      "--property=KillMode=control-group",
      "--property=TimeoutStopSec=15s",
      `--working-directory=${p.root}`,
      `--setenv=PATH=${process.env.PATH}`,
      `--setenv=LIZARDTAIL_STATE_DIR=${stateHome()}`,
      process.execPath,
      entry,
      "_managed-worker",
      file,
    ]);
    const deadline =
      Date.now() +
      Object.values(p.project.services).reduce(
        (n, s) => n + (s.ready?.timeoutMs ?? 60000),
        0,
      ) +
      30000;
    while (Date.now() < deadline) {
      const rt = await json<Runtime>(path.join(p.dir, "runtime.json"));
      if (rt.status === "ready") return;
      if (rt.status === "failed" || !(await alive(p.unit)))
        throw Error(rt.error ?? "Supervisor stopped; inspect logs");
      await new Promise((r) => setTimeout(r, 300));
    }
    throw Error("Startup timed out");
  } catch (e) {
    await down(p).catch((err) => console.error("Cleanup:", String(err)));
    throw e;
  }
}
async function finish(p: Plan, pr: string) {
  if (p.instance === "main") throw Error("Cannot finish main");
  if (!/^\d+$/.test(pr)) throw Error("Use a numeric PR number");
  const meta = JSON.parse(
    await run(
      "gh",
      [
        "pr",
        "view",
        pr,
        "--json",
        "state,headRefOid,baseRefName,mergeCommit,url",
      ],
      { cwd: p.root },
    ),
  );
  if (meta.state !== "MERGED") throw Error("PR is not merged");
  const repository = JSON.parse(
    await run("gh", ["repo", "view", "--json", "defaultBranchRef"], {
      cwd: p.root,
    }),
  );
  if (meta.baseRefName !== repository.defaultBranchRef?.name)
    throw Error(
      "Cleanup requires a PR merged into the repository default branch",
    );
  const head = (
    await run("git", ["rev-parse", "HEAD"], { cwd: p.root })
  ).trim();
  if (meta.headRefOid !== head)
    throw Error("Worktree head differs from merged PR head");
  if ((await run("git", ["status", "--porcelain"], { cwd: p.root })).trim())
    throw Error("Worktree has unsaved changes; refusing cleanup");
  const main = Object.values((await registry()).instances).find(
    (x) =>
      x.common === p.common &&
      x.project.project === p.project.project &&
      x.instance === "main",
  );
  if (!main) throw Error("Register main first");
  const mainBranch = (
    await run("git", ["branch", "--show-current"], { cwd: main.root })
  ).trim();
  if (
    mainBranch !== meta.baseRefName ||
    (await run("git", ["status", "--porcelain"], { cwd: main.root })).trim()
  )
    throw Error("Main checkout must be clean and on the PR base branch");
  const journal = path.join(p.dir, "finish.json");
  await atomic(journal, { stage: "merged", pr: meta.url, head });
  await run("git", ["fetch", "origin", meta.baseRefName], { cwd: main.root });
  const target = (
    await run("git", ["rev-parse", "FETCH_HEAD"], { cwd: main.root })
  ).trim();
  await run(
    "git",
    ["merge-base", "--is-ancestor", meta.mergeCommit.oid, target],
    { cwd: main.root },
  );
  await down(main);
  await run("git", ["merge", "--ff-only", target], { cwd: main.root });
  const updated = await plan(main.root, "main");
  await startDatabase(updated);
  if (updated.project.database?.kind === "postgres")
    await writeFile(
      path.join(updated.dir, `backup-${Date.now()}.sql`),
      await dumpDatabase(updated),
      { mode: 0o600 },
    );
  else if (updated.project.database)
    await run("python3", [
      "-c",
      "import sqlite3,sys; s=sqlite3.connect(sys.argv[1]);d=sqlite3.connect(sys.argv[2]);s.backup(d);d.close();s.close()",
      path.join(updated.dir, "database.sqlite"),
      path.join(updated.dir, `backup-${Date.now()}.sqlite`),
    ]);
  for (const c of updated.project.update ?? []) await action(updated, c);
  await up(updated);
  await atomic(journal, { stage: "main-ready", pr: meta.url, head, target });
  if (
    (await run("git", ["rev-parse", "HEAD"], { cwd: p.root })).trim() !==
      head ||
    (await run("git", ["status", "--porcelain"], { cwd: p.root })).trim()
  )
    throw Error("Feature changed during finish; preserving resources");
  await down(p);
  await stopResources(p, true);
  await deleteServices(p);
  await atomic(journal, { stage: "cleaned", pr: meta.url, head, target });
  for (const f of ["database.ready", "storage.ready"])
    await rm(path.join(p.dir, f), { force: true });
}
export async function managed(argv: string[]): Promise<boolean> {
  if (argv[0] === "_managed-worker") {
    await worker(argv[1]);
    return true;
  }
  const commands = [
    "plan",
    "up",
    "down",
    "status",
    "logs",
    "doctor",
    "refresh",
    "db",
    "exec",
    "finish",
    "init",
  ];
  const locked = argv[0] === "_managed-locked";
  if (locked) argv = argv.slice(1);
  if (!commands.includes(argv[0])) return false;
  if (!locked && !["status", "logs", "doctor"].includes(argv[0])) {
    process.exitCode = await withLock(argv, entry);
    return true;
  }
  const separator = argv.indexOf("--");
  const executable = separator < 0 ? [] : argv.slice(separator + 1);
  const args = separator < 0 ? [...argv] : argv.slice(0, separator);
  const take = (key: string) => {
    const i = args.indexOf(key);
    if (i < 0) return undefined;
    if (!args[i + 1]) throw Error(`${key} requires a value`);
    return args.splice(i, 2)[1];
  };
  const instance = take("--instance");
  const cwd = take("--project-dir") ?? process.cwd();
  const dumpSource = take("--source-dump-file");
  const source = take("--source-env-file"),
    sourceKey = take("--source-key") ?? "DATABASE_URL",
    pr = take("--pr");
  const asJSON = args.includes("--json");
  if (asJSON) args.splice(args.indexOf("--json"), 1);
  if (instance) assertName(instance);
  if (args[0] === "init") {
    const file = path.join(cwd, "lizardtail.project.json");
    await writeFile(
      file,
      JSON.stringify(
        {
          version: 1,
          project: path
            .basename(cwd)
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-"),
          services: {
            web: {
              command: [
                "npm",
                "run",
                "dev",
                "--",
                "--host",
                "127.0.0.1",
                "--port",
                "${port.web}",
                "--strictPort",
              ],
              port: true,
              ready: { path: "/" },
            },
          },
          endpoints: { app: { routes: [{ path: "/", service: "web" }] } },
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    console.log(file);
    return true;
  }
  if (args[0] === "status") {
    const rows = await Promise.all(
      Object.values((await registry()).instances).map(async (p) => ({
        project: p.project.project,
        instance: p.instance,
        root: p.root,
        unit: p.unit,
        urls: p.origins,
        active: await alive(p.unit),
        runtime: await json(path.join(p.dir, "runtime.json"), null),
      })),
    );
    console.log(JSON.stringify(rows, null, 2));
    return true;
  }
  if (args[0] === "doctor") {
    const p = await current(cwd, instance).catch(() => undefined);
    const d = await doctor(p);
    console.log(JSON.stringify(d, null, 2));
    if (Object.values(d).some((x) => !x.ok)) process.exitCode = 1;
    return true;
  }
  const p = ["plan", "up"].includes(args[0])
    ? await plan(cwd, instance)
    : await current(cwd, instance);
  if (args[0] === "up") await up(p);
  else if (args[0] === "down") await down(p);
  else if (args[0] === "refresh") {
    await down(p);
    await startDatabase(p);
    await startStorage(p);
    for (const c of p.project.update ?? []) await action(p, c);
    await up(p);
  } else if (args[0] === "logs") {
    console.log(
      await run("journalctl", [
        "--user",
        "-u",
        p.unit,
        "-n",
        "100",
        "--no-pager",
      ]),
    );
    return true;
  } else if (args[0] === "finish") {
    if (!pr) throw Error("finish requires --pr NUMBER");
    await finish(p, pr);
  } else if (args[0] === "exec") {
    if (!executable.length) throw Error("Use exec -- COMMAND ARG...");
    if (
      p.project.database &&
      !(await exists(path.join(p.dir, "database.ready")))
    )
      throw Error("Initialize the local database first");
    await startDatabase(p);
    await startStorage(p);
    process.stdout.write(await action(p, executable));
    return true;
  } else if (args[0] === "db") {
    if (args[1] === "import" && dumpSource)
      await importDump(p, path.resolve(dumpSource));
    else if (args[1] === "import" && source)
      await importDatabase(p, path.resolve(source), sourceKey);
    else if (args[1] === "migrate") {
      await startDatabase(p);
      if (!p.project.database) throw Error("No database");
      if (
        p.instance === "main" &&
        p.project.database.source === "import" &&
        !(await exists(path.join(p.dir, "database.ready")))
      )
        throw Error("Import main before migrating");
      await action(p, p.project.database.migrate, p.project.database.cwd);
      await markDatabase(p);
    } else throw Error("Use db import --source-env-file FILE or db migrate");
  }
  console.log(
    JSON.stringify(
      {
        project: p.project.project,
        instance: p.instance,
        root: p.root,
        ports: p.ports,
        urls: p.origins,
        unit: p.unit,
        services: Object.entries(p.names).map(([endpoint, name]) => ({
          endpoint,
          name: "svc:" + name,
          ports: ["tcp:443"],
        })),
      },
      null,
      2,
    ),
  );
  return true;
}

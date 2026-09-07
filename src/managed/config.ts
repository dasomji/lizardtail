import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export interface Service {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  envFiles?: string[];
  port?: boolean;
  dependsOn?: string[];
  ready?: { path: string; status?: number; timeoutMs?: number };
}
export interface Endpoint {
  routes: { path: string; service: string; stripPrefix?: boolean }[];
}
export interface Project {
  version: 1;
  project: string;
  services: Record<string, Service>;
  endpoints: Record<string, Endpoint>;
  envFiles?: string[];
  env?: Record<string, string>;
  database?: {
    kind: "postgres" | "sqlite";
    image?: string;
    volumePath?: string;
    source?: string;
    migrate: string[];
    cwd?: string;
  };
  storage?: { image: string };
  update?: string[][];
}
export interface Host {
  portMin: number;
  portMax: number;
  blockedPorts: number[];
  exposure: "service" | "port" | "none";
  tailnet?: string;
  dockerContext: string;
  caddy: string;
}
export const defaults: Host = {
  portMin: 20000,
  portMax: 29999,
  blockedPorts: [80, 443],
  exposure: "service",
  dockerContext: "rootless",
  caddy: "caddy",
};
export function assertName(v: unknown): asserts v is string {
  if (typeof v !== "string" || !/^[a-z][a-z0-9-]{0,35}$/.test(v))
    throw Error(`Invalid name: ${String(v)}`);
}
function command(v: unknown) {
  if (
    !Array.isArray(v) ||
    !v.length ||
    v.some((x) => typeof x !== "string" || !x || x.includes("\0"))
  )
    throw Error("command must be a nonempty argument array");
}
export function validateProject(p: Project): Project {
  if (p.version !== 1) throw Error("Project version must be 1");
  assertName(p.project);
  if (!p.services || !Object.keys(p.services).length)
    throw Error("services required");
  for (const [n, s] of Object.entries(p.services)) {
    assertName(n);
    if (n === "db" || n === "storage" || n.startsWith("gateway-"))
      throw Error(`${n}: reserved resource name`);
    command(s.command);
    if (s.ready && !s.port) throw Error(`${n}: ready requires port`);
    if (
      s.ready &&
      (!s.ready.path.startsWith("/") ||
        (s.ready.timeoutMs !== undefined &&
          (!Number.isFinite(s.ready.timeoutMs) || s.ready.timeoutMs <= 0)))
    )
      throw Error(`${n}: invalid readiness check`);
    for (const d of s.dependsOn ?? [])
      if (!p.services[d]) throw Error(`Unknown dependency ${d}`);
  }
  order(p);
  if (!p.endpoints || !Object.keys(p.endpoints).length)
    throw Error("endpoints required");
  for (const [n, e] of Object.entries(p.endpoints)) {
    assertName(n);
    if (!Array.isArray(e.routes) || !e.routes.length)
      throw Error(`${n}: routes required`);
    const seen = new Set();
    for (const r of e.routes) {
      if (
        !(
          p.services[r.service]?.port ||
          (r.service === "storage" && p.storage)
        ) ||
        !/^\/(?:[a-zA-Z0-9_./-]*\*?)?$/.test(r.path) ||
        seen.has(r.path)
      )
        throw Error(`Invalid or duplicate route ${r.path}`);
      seen.add(r.path);
      if (r.stripPrefix && (r.path === "/" || !r.path.endsWith("/*")))
        throw Error("stripPrefix requires /prefix/*");
    }
  }
  if (p.database) {
    if (!["postgres", "sqlite"].includes(p.database.kind))
      throw Error("Unsupported database");
    command(p.database.migrate);
    if (
      p.database.volumePath &&
      !["/var/lib/postgresql", "/var/lib/postgresql/data"].includes(
        p.database.volumePath,
      )
    )
      throw Error("Unsupported PostgreSQL volumePath");
    if (p.database.kind === "postgres" && !p.database.image)
      throw Error("Pin a postgres image");
  }
  for (const c of p.update ?? []) command(c);
  return p;
}
export function order(p: Project): string[] {
  const done = new Set<string>(),
    visiting = new Set<string>(),
    out: string[] = [];
  function visit(n: string) {
    if (done.has(n)) return;
    if (visiting.has(n)) throw Error("Cyclic service dependencies");
    visiting.add(n);
    for (const d of p.services[n].dependsOn ?? []) visit(d);
    visiting.delete(n);
    done.add(n);
    out.push(n);
  }
  for (const n of Object.keys(p.services)) visit(n);
  return out;
}
export function expand(s: string, values: Record<string, string>): string {
  return s.replace(/\$\{([a-zA-Z0-9_.-]+)\}/g, (_, k) => {
    if (values[k] === undefined) throw Error(`Unresolved variable ${k}`);
    return values[k];
  });
}
export async function projectAt(
  cwd: string,
): Promise<{ root: string; project: Project }> {
  let dir = await realpath(cwd);
  for (;;) {
    try {
      return {
        root: dir,
        project: validateProject(
          JSON.parse(
            await readFile(path.join(dir, "lizardtail.project.json"), "utf8"),
          ),
        ),
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw Error("No lizardtail.project.json found");
    dir = parent;
  }
}
export async function identity(
  root: string,
  project: string,
  instance?: string,
) {
  let common = root,
    branch = "";
  try {
    common = (
      await exec(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        { cwd: root },
      )
    ).stdout.trim();
    branch = (
      await exec("git", ["branch", "--show-current"], { cwd: root })
    ).stdout.trim();
  } catch {}
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  const label =
    instance ??
    `${
      (branch || "worktree")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 20) || "worktree"
    }-${hash}`;
  assertName(label);
  return {
    id: createHash("sha256")
      .update(common + "\0" + project + "\0" + label)
      .digest("hex")
      .slice(0, 16),
    instance: label,
    common,
    branch,
  };
}

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rename, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { defaults, type Host, type Project } from "./config.js";
export const stateHome = () =>
  process.env.LIZARDTAIL_STATE_DIR ??
  path.join(
    process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local/state"),
    "lizardtail",
  );
export const hostPath = () =>
  process.env.LIZARDTAIL_HOST_CONFIG ??
  path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
    "lizardtail/host.json",
  );
export interface Plan {
  id: string;
  instance: string;
  common: string;
  branch: string;
  root: string;
  project: Project;
  host: Host;
  ports: Record<string, number>;
  origins: Record<string, string>;
  names: Record<string, string>;
  externalPorts: Record<string, number>;
  dir: string;
  unit: string;
  createdAt: string;
}
export interface Registry {
  instances: Record<string, Plan>;
}
export async function json<T>(file: string, fallback?: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (
      (e as NodeJS.ErrnoException).code === "ENOENT" &&
      fallback !== undefined
    )
      return fallback;
    throw e;
  }
}
export async function atomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + "." + process.pid + ".tmp";
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, file);
}
export async function registry() {
  return json<Registry>(path.join(stateHome(), "registry.json"), {
    instances: {},
  });
}
export async function save(r: Registry) {
  await atomic(path.join(stateHome(), "registry.json"), r);
}
export async function host(): Promise<Host> {
  const h = { ...defaults, ...(await json<Partial<Host>>(hostPath(), {})) };
  if (
    !Number.isInteger(h.portMin) ||
    !Number.isInteger(h.portMax) ||
    h.portMin < 1024 ||
    h.portMax > 65535 ||
    h.portMin > h.portMax ||
    !["service", "port", "none"].includes(h.exposure) ||
    !Array.isArray(h.blockedPorts) ||
    h.blockedPorts.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)
  )
    throw Error("Invalid host policy");
  return h;
}
export async function run(
  cmd: string,
  args: string[] = [],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string | Buffer;
    timeout?: number;
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Error(`${cmd} timed out`));
    }, options.timeout ?? 60000);
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.stdin.on("error", () => {});
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(out)
        : reject(Error(`${cmd} failed (${code}): ${err.slice(-2000)}`));
    });
    child.stdin.end(options.input);
  });
}
export async function free(port: number): Promise<boolean> {
  const probe = (address: string): Promise<boolean> =>
    new Promise((resolve) => {
      const s = net.createServer();
      s.once("error", (error: NodeJS.ErrnoException) =>
        resolve(
          address === "::1" &&
            ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code ?? ""),
        ),
      );
      s.listen({ port, host: address, exclusive: true }, () =>
        s.close(() => resolve(true)),
      );
    });
  return (await probe("127.0.0.1")) && (await probe("::1"));
}
export async function alive(unit: string) {
  try {
    return (
      (await run("systemctl", ["--user", "is-active", unit])).trim() ===
      "active"
    );
  } catch {
    return false;
  }
}
export async function exists(file: string) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
export async function withLock(args: string[], entry: string) {
  await mkdir(stateHome(), { recursive: true, mode: 0o700 });
  return new Promise<number>((resolve, reject) => {
    const p = spawn(
      "flock",
      [
        "--exclusive",
        "--close",
        path.join(stateHome(), "registry.lock"),
        process.execPath,
        entry,
        "_managed-locked",
        ...args,
      ],
      { stdio: "inherit" },
    );
    p.on("error", reject);
    p.on("exit", (c) => resolve(c ?? 1));
  });
}

import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { run, free, exists, type Plan } from "./system.js";
export interface Bridge {
  unit: string;
  socket: string;
  port: number;
}
const unitDir = () =>
  path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
    "systemd/user",
  );
export function bridgeFor(
  p: Plan,
  endpoint: string,
  generation: string,
  socket: string,
): Bridge {
  return {
    unit: `lizardtail-${p.id}-${createHash("sha256").update(endpoint).digest("hex").slice(0, 6)}-${generation}`,
    socket,
    port: p.ports["gateway-" + endpoint],
  };
}
export async function startBridge(b: Bridge) {
  if (!(await free(b.port))) throw Error(`Gateway port ${b.port} is occupied`);
  if (/[\n\r%"\\]/.test(b.socket))
    throw Error("Unsupported socket path in systemd unit");
  const dir = unitDir();
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, b.unit + ".socket"),
    `[Unit]\nDescription=Lizardtail reserved gateway ${b.unit}\n[Socket]\nListenStream=127.0.0.1:${b.port}\nNoDelay=true\n[Install]\nWantedBy=sockets.target\n`,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(dir, b.unit + ".service"),
    `[Unit]\nDescription=Lizardtail Unix socket bridge ${b.unit}\nRequires=${b.unit}.socket\nAfter=${b.unit}.socket\n[Service]\nExecStart=/usr/lib/systemd/systemd-socket-proxyd "${b.socket}"\nNoNewPrivileges=true\n`,
    { mode: 0o600 },
  );
  await run("systemctl", ["--user", "daemon-reload"]);
  await run("systemctl", ["--user", "enable", "--now", b.unit + ".socket"]);
}
export async function stopBridges(bridges: Bridge[]) {
  for (const b of bridges) {
    if (!/^lizardtail-[a-f0-9]{16}-[a-f0-9]{6}-[a-f0-9]{16}$/.test(b.unit))
      throw Error("Invalid owned bridge unit");
    if (!(await exists(path.join(unitDir(), b.unit + ".socket")))) continue;
    await run("systemctl", ["--user", "disable", "--now", b.unit + ".socket"]);
    await run("systemctl", ["--user", "stop", b.unit + ".service"]);
    for (const suffix of [".socket", ".service"])
      await rm(path.join(unitDir(), b.unit + suffix), { force: true });
  }
  if (bridges.length) await run("systemctl", ["--user", "daemon-reload"]);
}

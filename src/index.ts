#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import net from "node:net";
import process from "node:process";
import { fileURLToPath } from "node:url";

export interface Options {
  command: string[];
  host: string;
  port?: number;
  timeoutMs: number;
  openCheck: boolean;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

export function printUsage(): void {
  console.error(`Usage: lizardtail [options] -- <command> [args...]
       lizardtail [options] <command> [args...]

Options:
  --port <port>        Expose this port instead of detecting one from output.
  --host <host>        Local host to expose. Default: 127.0.0.1
  --timeout <ms>       Port-detection timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --no-open-check      Skip waiting for the local port to accept connections.
  -h, --help           Show this help.

Examples:
  lizardtail pnpm dev
  lizardtail --port 3000 npm run dev
`);
}

function usage(): never {
  printUsage();
  process.exit(2);
}

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    command: [],
    host: "127.0.0.1",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    openCheck: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--") {
      options.command = argv.slice(i + 1);
      break;
    }

    if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--no-open-check") {
      options.openCheck = false;
      continue;
    }

    if (arg === "--port") {
      const value = argv[++i];
      if (!value) usage();
      options.port = parsePort(value);
      continue;
    }

    if (arg.startsWith("--port=")) {
      options.port = parsePort(arg.slice("--port=".length));
      continue;
    }

    if (arg === "--host") {
      const value = argv[++i];
      if (!value) usage();
      options.host = value;
      continue;
    }

    if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length);
      continue;
    }

    if (arg === "--timeout") {
      const value = argv[++i];
      if (!value) usage();
      options.timeoutMs = parseTimeout(value);
      continue;
    }

    if (arg.startsWith("--timeout=")) {
      options.timeoutMs = parseTimeout(arg.slice("--timeout=".length));
      continue;
    }

    if (arg.startsWith("-")) {
      console.error(`lizardtail: unknown option ${arg}`);
      usage();
    }

    options.command = argv.slice(i);
    break;
  }

  if (options.command.length === 0) usage();

  return options;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    console.error(`lizardtail: invalid port: ${value}`);
    process.exit(2);
  }
  return port;
}

function parseTimeout(value: string): number {
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1) {
    console.error(`lizardtail: invalid timeout: ${value}`);
    process.exit(2);
  }
  return timeout;
}

export function stripAnsi(input: string): string {
  return input.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

export function detectPortFromText(text: string): number | undefined {
  const clean = stripAnsi(text);

  const localUrl = clean.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)(?::(\d{1,5}))?/i);
  if (localUrl?.[1]) return validDetectedPort(localUrl[1]);

  const anyLocalUrl = clean.match(/(?:Local|localhost|loopback|listening|ready|server|started|running)[^\n\r]*?(?:on|at|:)?\s*(?:https?:\/\/)?(?:[^\s:]+:)?(\d{2,5})/i);
  if (anyLocalUrl?.[1]) return validDetectedPort(anyLocalUrl[1]);

  const portPhrase = clean.match(/\b(?:port|PORT)\s*(?:=|:|is|on)?\s*(\d{2,5})\b/);
  if (portPhrase?.[1]) return validDetectedPort(portPhrase[1]);

  return undefined;
}

function validDetectedPort(value: string): number | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTailscaleServePermissionError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("access denied") && (message.includes("sudo tailscale serve") || message.includes("operator"));
}

function tailscaleServePermissionHelp(target: string): string {
  return `Tailscale refused to update Serve config without elevated privileges.

Run this once to let your user manage Tailscale Serve:

  sudo tailscale set --operator=$USER

Then rerun lizardtail.

Or expose this server manually with:

  sudo tailscale serve --bg ${target}`;
}

async function exec(command: string, args: string[], opts: { input?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  const child = spawn(command, args, {
    stdio: [opts.input ? "pipe" : "ignore", "pipe", "pipe"],
    env: process.env,
  });

  let stdout = "";
  let stderr = "";

  if (!child.stdout || !child.stderr) {
    throw new Error(`failed to capture output for ${command}`);
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  if (opts.input) {
    if (!child.stdin) throw new Error(`failed to write input for ${command}`);
    child.stdin.end(opts.input);
  }

  const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  if (code !== 0) {
    const reason = signal ? `signal ${signal}` : `exit code ${code}`;
    throw new Error(`${command} ${args.join(" ")} failed with ${reason}\n${stderr || stdout}`.trim());
  }

  return { stdout, stderr };
}

export async function waitForOpenPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const isOpen = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port });
      const done = (result: boolean) => {
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(500);
      socket.once("connect", () => done(true));
      socket.once("timeout", () => done(false));
      socket.once("error", () => done(false));
    });

    if (isOpen) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`timed out waiting for ${host}:${port} to accept connections`);
}

export async function exposeWithTailscale(host: string, port: number): Promise<string> {
  await exec("tailscale", ["status"]);

  const target = `http://${host}:${port}`;
  try {
    await exec("tailscale", ["serve", "--bg", target]);
  } catch (firstError) {
    if (isTailscaleServePermissionError(firstError)) {
      throw new Error(tailscaleServePermissionHelp(target));
    }

    if (host !== "127.0.0.1" && host !== "localhost") throw firstError;

    try {
      await exec("tailscale", ["serve", "--bg", String(port)]);
    } catch (fallbackError) {
      if (isTailscaleServePermissionError(fallbackError)) {
        throw new Error(tailscaleServePermissionHelp(target));
      }
      throw fallbackError;
    }
  }

  const { stdout } = await exec("tailscale", ["status", "--json"]);
  const status = JSON.parse(stdout) as { Self?: { DNSName?: string; TailscaleIPs?: string[] } };
  const dnsName = status.Self?.DNSName?.replace(/\.$/, "");

  if (dnsName) return `https://${dnsName}`;

  const ip = status.Self?.TailscaleIPs?.find((value) => /^\d+\.\d+\.\d+\.\d+$/.test(value));
  if (ip) return `https://${ip}`;

  throw new Error("could not determine this device's Tailscale DNS name or IP");
}

export async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const [command, ...args] = options.command;

  const child = spawn(command, args, {
    stdio: ["inherit", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? "1" },
  });

  let exposed = false;
  let exposing: Promise<void> | undefined;
  let recentOutput = "";

  const stopChild = () => {
    if (!child.killed) child.kill("SIGTERM");
  };

  const expose = (port: number) => {
    if (exposed || exposing) return;
    exposed = true;
    exposing = (async () => {
      const localUrl = `http://${options.host}:${port}`;
      console.error(`\nlizardtail: detected local server on ${localUrl}`);
      if (options.openCheck) await waitForOpenPort(options.host, port, 10_000);
      const tailscaleUrl = await exposeWithTailscale(options.host, port);
      console.error(`lizardtail: serving via Tailscale: ${tailscaleUrl}\n`);
    })().catch((error: unknown) => {
      console.error(`lizardtail: failed to expose server: ${errorMessage(error)}`);
      stopChild();
      process.exitCode = 1;
    });
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const inspectChunk = (chunk: string) => {
    recentOutput = (recentOutput + chunk).slice(-8_000);
    const detectedPort = detectPortFromText(recentOutput);
    if (detectedPort) expose(detectedPort);
  };

  child.stdout.on("data", (chunk: string) => {
    process.stdout.write(chunk);
    if (!options.port) inspectChunk(chunk);
  });

  child.stderr.on("data", (chunk: string) => {
    process.stderr.write(chunk);
    if (!options.port) inspectChunk(chunk);
  });

  child.on("error", (error) => {
    console.error(`lizardtail: failed to start ${command}: ${error.message}`);
    process.exit(1);
  });

  if (options.port) expose(options.port);

  const timeout = options.port
    ? undefined
    : setTimeout(() => {
        if (!exposed) {
          console.error(`lizardtail: no server port detected within ${options.timeoutMs}ms`);
          stopChild();
          process.exitCode = 1;
        }
      }, options.timeoutMs);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      child.kill(signal);
    });
  }

  const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  if (timeout) clearTimeout(timeout);
  if (exposing) await exposing;

  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? process.exitCode ?? 0);
}

function isCliEntrypoint(): boolean {
  if (!process.argv[1]) return false;

  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isCliEntrypoint()) {
  main().catch((error: unknown) => {
    console.error(`lizardtail: ${errorMessage(error)}`);
    process.exit(1);
  });
}

#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export interface Options {
  command: string[];
  host: string;
  port?: number;
  tailscalePort?: number;
  viteTailscalePort?: number;
  timeoutMs: number;
  openCheck: boolean;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
const DETECTION_SETTLE_MS = 1_500;

export function printUsage(): void {
  console.error(`Usage: lizardtail [options] -- <command> [args...]
       lizardtail [options] <command> [args...]

Options:
  --port <port>        Expose this port instead of detecting one from output.
  --host <host>        Local host to expose. Default: 127.0.0.1
  --timeout <ms>       Port-detection timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --tailscale-port <port>
                       Expose the main app on this Tailscale HTTPS port instead of 443.
  --vite-tailscale-port <port>
                       Expose a detected Laravel Vite server on this Tailscale HTTPS port.
  --no-open-check      Skip waiting for the local port to accept connections.
  -h, --help           Show this help.

Examples:
  lizardtail pnpm dev
  lizardtail --port 3000 npm run dev
  lizardtail --tailscale-port 8450 pnpm dev
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

    if (arg === "--tailscale-port" || arg === "--https-port") {
      const value = argv[++i];
      if (!value) usage();
      options.tailscalePort = parsePort(value);
      continue;
    }

    if (arg.startsWith("--tailscale-port=")) {
      options.tailscalePort = parsePort(arg.slice("--tailscale-port=".length));
      continue;
    }

    if (arg.startsWith("--https-port=")) {
      options.tailscalePort = parsePort(arg.slice("--https-port=".length));
      continue;
    }

    if (arg === "--vite-tailscale-port" || arg === "--vite-https-port") {
      const value = argv[++i];
      if (!value) usage();
      options.viteTailscalePort = parsePort(value);
      continue;
    }

    if (arg.startsWith("--vite-tailscale-port=")) {
      options.viteTailscalePort = parsePort(arg.slice("--vite-tailscale-port=".length));
      continue;
    }

    if (arg.startsWith("--vite-https-port=")) {
      options.viteTailscalePort = parsePort(arg.slice("--vite-https-port=".length));
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

interface PortCandidate {
  port: number;
  score: number;
}

export function detectPortFromText(text: string): number | undefined {
  const candidates = detectPortCandidates(text);
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.port;
}

function detectPortCandidates(text: string): PortCandidate[] {
  const clean = stripAnsi(text);
  const candidates: PortCandidate[] = [];

  for (const line of clean.split(/\r?\n/)) {
    candidates.push(...detectPortCandidatesFromLine(line));
  }

  return candidates;
}

function detectPortCandidatesFromLine(line: string): PortCandidate[] {
  const candidates: PortCandidate[] = [];
  const lowerLine = line.toLowerCase();
  const lineLooksLikeDuration = /\b\d{1,5}\s*ms\b/i.test(line);
  const lineLooksLikeServer = /\b(server|listening|started|running)\b/i.test(line) || /\[server\]/i.test(line);
  const lineLooksLikeVite = /\[vite\]|\bvite\b/i.test(line);

  const localUrlPattern = /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1):(\d{1,5})/gi;
  for (const match of line.matchAll(localUrlPattern)) {
    const port = validDetectedPort(match[2]);
    if (!port) continue;

    let score = 70;
    if (lineLooksLikeServer) score += 30;
    if (lineLooksLikeVite) score -= 15;
    if (match[1] === "0.0.0.0") score -= 10;
    candidates.push({ port, score });
  }

  if (lineLooksLikeDuration) return candidates;

  const portPhrase = line.match(/\b(?:port|PORT)\s*(?:=|:|is|on)?\s*(\d{2,5})\b/);
  if (portPhrase?.[1]) {
    const port = validDetectedPort(portPhrase[1]);
    if (port) candidates.push({ port, score: lowerLine.includes("in use") ? 20 : 45 });
  }

  const serverPort = line.match(/\b(?:listening|started|running|server)\b[^\n\r]*:(\d{2,5})\b/i);
  if (serverPort?.[1]) {
    const port = validDetectedPort(serverPort[1]);
    if (port) candidates.push({ port, score: lineLooksLikeServer ? 60 : 40 });
  }

  return candidates;
}

function validDetectedPort(value: string): number | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

interface LaravelViteDetection {
  appPort?: number;
  vitePort?: number;
  viteHost?: string;
}

export function detectLaravelViteServers(text: string): LaravelViteDetection {
  const clean = stripAnsi(text);
  const detection: LaravelViteDetection = {};

  const appMatch = clean.match(/\[server\][^\n\r]*Server running on \[http:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|::1):(\d{1,5})\]/i);
  const appPort = appMatch?.[1] ? validDetectedPort(appMatch[1]) : undefined;
  if (appPort) detection.appPort = appPort;

  const viteMatch = [...clean.matchAll(/\[vite\][^\n\r]*(?:Local:)\s*http:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1):(\d{1,5})\/?/gi)].at(-1);
  const vitePort = viteMatch?.[2] ? validDetectedPort(viteMatch[2]) : undefined;
  if (vitePort) {
    detection.vitePort = vitePort;
    detection.viteHost = normalizeLocalHost(viteMatch?.[1] ?? "localhost");
  }

  return detection;
}

function normalizeLocalHost(host: string): string {
  return host === "[::1]" || host === "::1" ? "localhost" : host;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTailscaleServePermissionError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("access denied") && (message.includes("sudo tailscale serve") || message.includes("operator"));
}

function tailscaleServeCommand(target: string, tailscalePort?: number): string[] {
  const args = ["serve", "--bg"];
  if (tailscalePort !== undefined) args.push("--https", String(tailscalePort));
  args.push(target);
  return args;
}

function tailscaleUrl(dnsName: string, tailscalePort?: number): string {
  return tailscalePort === undefined ? `https://${dnsName}` : `https://${dnsName}:${tailscalePort}`;
}

function tailscaleServePermissionHelp(target: string, tailscalePort?: number): string {
  return `Tailscale refused to update Serve config without elevated privileges.

Run this once to let your user manage Tailscale Serve:

  sudo tailscale set --operator=$USER

Then rerun lizardtail.

Or expose this server manually with:

  sudo tailscale ${tailscaleServeCommand(target, tailscalePort).join(" ")}`;
}

async function exec(command: string, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string; stderr: string }> {
  const childEnv = opts.env ?? process.env;
  
  const child = spawn(command, args, {
    stdio: [opts.input ? "pipe" : "ignore", "pipe", "pipe"],
    env: childEnv,
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

async function getTailscaleDnsName(): Promise<string | undefined> {
  const { stdout } = await exec("tailscale", ["status", "--json"]);
  const status = JSON.parse(stdout) as { Self?: { DNSName?: string } };
  return status.Self?.DNSName?.replace(/\.$/, "");
}

interface TailscaleServeStatus {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

async function getTailscaleServeStatus(): Promise<TailscaleServeStatus | undefined> {
  try {
    const { stdout } = await exec("tailscale", ["serve", "status", "--json"]);
    return JSON.parse(stdout) as TailscaleServeStatus;
  } catch {
    return undefined;
  }
}

async function getTailscaleServeProxy(port: number): Promise<string | undefined> {
  const status = await getTailscaleServeStatus();
  if (!status?.Web) return undefined;

  const suffix = `:${port}`;
  const webKey = Object.keys(status.Web).find((key) => key.endsWith(suffix));
  if (!webKey) return undefined;

  return status.Web[webKey]?.Handlers?.["/"]?.Proxy;
}

function normalizeProxyTarget(target: string): string {
  return target.replace("http://localhost:", "http://127.0.0.1:").replace(/\/$/, "");
}

async function resolveTailscaleHttpsPort(target: string, requestedPort?: number): Promise<number | undefined> {
  if (requestedPort !== undefined) return requestedPort;

  const defaultProxy = await getTailscaleServeProxy(443);
  if (!defaultProxy || normalizeProxyTarget(defaultProxy) === normalizeProxyTarget(target)) return undefined;

  return chooseTailscaleHttpsPort();
}

async function chooseTailscaleHttpsPort(excludedPort?: number): Promise<number> {
  const usedPorts = new Set<number>();
  const status = await getTailscaleServeStatus();

  if (status?.Web) {
    for (const key of Object.keys(status.Web)) {
      const match = key.match(/:(\d{2,5})$/);
      const port = match?.[1] ? validDetectedPort(match[1]) : undefined;
      if (port) usedPorts.add(port);
    }
  }

  for (let port = 8443; port <= 8999; port += 1) {
    if (port !== excludedPort && !usedPorts.has(port)) return port;
  }

  throw new Error("could not find an available Tailscale HTTPS port");
}

async function writeLaravelHotFile(viteUrl: string): Promise<string | undefined> {
  const publicDir = path.join(process.cwd(), "public");
  if (!existsSync(publicDir)) return undefined;

  const hotPath = path.join(publicDir, "hot");
  await writeFile(hotPath, viteUrl);
  return hotPath;
}

async function startCorsProxy(targetHost: string, targetPort: number): Promise<{ host: string; port: number }> {
  const server = createServer((incoming, response) => {
    if (incoming.method === "OPTIONS") {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }

    const upstream = httpRequest(
      {
        host: targetHost,
        port: targetPort,
        method: incoming.method,
        path: incoming.url,
        headers: { ...incoming.headers, host: `${targetHost}:${targetPort}` },
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, {
          ...upstreamResponse.headers,
          ...corsHeaders(),
        });
        upstreamResponse.pipe(response);
      },
    );

    upstream.on("error", (error) => {
      response.writeHead(502, corsHeaders());
      response.end(`lizardtail Vite proxy error: ${error.message}`);
    });

    incoming.pipe(upstream);
  });

  server.on("upgrade", (request, socket, head) => {
    const upstream = net.connect(targetPort, targetHost, () => {
      upstream.write(`${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion}\r\n`);
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        upstream.write(`${name}: ${Array.isArray(value) ? value.join(",") : value}\r\n`);
      }
      upstream.write(`\r\n`);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });

    upstream.on("error", () => socket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to start Vite CORS proxy");

  return { host: "127.0.0.1", port: address.port };
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

export async function exposeWithTailscale(host: string, port: number, tailscalePort?: number): Promise<string> {
  await exec("tailscale", ["status"]);

  const target = `http://${host}:${port}`;
  const resolvedTailscalePort = await resolveTailscaleHttpsPort(target, tailscalePort);

  try {
    await exec("tailscale", tailscaleServeCommand(target, resolvedTailscalePort));
  } catch (firstError) {
    if (isTailscaleServePermissionError(firstError)) {
      throw new Error(tailscaleServePermissionHelp(target, resolvedTailscalePort));
    }

    if (host !== "127.0.0.1" && host !== "localhost") throw firstError;

    try {
      await exec("tailscale", tailscaleServeCommand(String(port), resolvedTailscalePort));
    } catch (fallbackError) {
      if (isTailscaleServePermissionError(fallbackError)) {
        throw new Error(tailscaleServePermissionHelp(target, resolvedTailscalePort));
      }
      throw fallbackError;
    }
  }

  const { stdout } = await exec("tailscale", ["status", "--json"]);
  const status = JSON.parse(stdout) as { Self?: { DNSName?: string; TailscaleIPs?: string[] } };
  const dnsName = status.Self?.DNSName?.replace(/\.$/, "");

  if (dnsName) return tailscaleUrl(dnsName, resolvedTailscalePort);

  const ip = status.Self?.TailscaleIPs?.find((value) => /^\d+\.\d+\.\d+\.\d+$/.test(value));
  if (ip) return tailscaleUrl(ip, resolvedTailscalePort);

  throw new Error("could not determine this device's Tailscale DNS name or IP");
}

export async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const [command, ...args] = options.command;
  const tailscaleDnsName = await getTailscaleDnsName().catch(() => undefined);
  const childEnv: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? "1" };

  if (tailscaleDnsName) {
    childEnv.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = childEnv.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS
      ? `${childEnv.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS},${tailscaleDnsName}`
      : tailscaleDnsName;
  }

  const child = spawn(command, args, {
    stdio: ["inherit", "pipe", "pipe"],
    env: childEnv,
  });

  let exposed = false;
  let exposing: Promise<void> | undefined;
  let recentOutput = "";
  let detectionTimer: NodeJS.Timeout | undefined;

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
      const tailscaleUrl = await exposeWithTailscale(options.host, port, options.tailscalePort);
      console.error(`lizardtail: serving via Tailscale: ${tailscaleUrl}\n`);
    })().catch((error: unknown) => {
      console.error(`lizardtail: failed to expose server: ${errorMessage(error)}`);
      stopChild();
      process.exitCode = 1;
    });
  };

  const exposeLaravelVite = (appPort: number, vitePort: number, viteHost: string) => {
    if (exposed || exposing) return;
    exposed = true;
    exposing = (async () => {
      const appLocalUrl = `http://${options.host}:${appPort}`;
      const viteLocalUrl = `http://${viteHost}:${vitePort}`;
      console.error(`\nlizardtail: detected Laravel app server on ${appLocalUrl}`);
      console.error(`lizardtail: detected Vite asset server on ${viteLocalUrl}`);

      if (options.openCheck) {
        await waitForOpenPort(options.host, appPort, 10_000);
        await waitForOpenPort(viteHost, vitePort, 10_000);
      }

      const appUrl = await exposeWithTailscale(options.host, appPort, options.tailscalePort);
      const viteProxy = await startCorsProxy(viteHost, vitePort);
      const viteTailscalePort = options.viteTailscalePort ?? (await chooseTailscaleHttpsPort(options.tailscalePort));
      const viteUrl = await exposeWithTailscale(viteProxy.host, viteProxy.port, viteTailscalePort);
      const hotPath = await writeLaravelHotFile(viteUrl);

      console.error(`lizardtail: serving Laravel via Tailscale: ${appUrl}`);
      console.error(`lizardtail: serving Vite assets via Tailscale: ${viteUrl}`);
      console.error(`lizardtail: proxying Vite through local CORS proxy: http://${viteProxy.host}:${viteProxy.port} -> ${viteLocalUrl}`);
      if (hotPath) console.error(`lizardtail: wrote Laravel Vite hot file: ${hotPath}`);
      console.error("");
    })().catch((error: unknown) => {
      console.error(`lizardtail: failed to expose Laravel/Vite servers: ${errorMessage(error)}`);
      stopChild();
      process.exitCode = 1;
    });
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const inspectChunk = (chunk: string) => {
    recentOutput = (recentOutput + chunk).slice(-8_000);
    const detectedPort = detectPortFromText(recentOutput);
    if (!detectedPort || exposed || exposing) return;

    if (detectionTimer) clearTimeout(detectionTimer);
    detectionTimer = setTimeout(() => {
      detectionTimer = undefined;
      const laravelVite = detectLaravelViteServers(recentOutput);
      if (laravelVite.appPort && laravelVite.vitePort) {
        exposeLaravelVite(laravelVite.appPort, laravelVite.vitePort, laravelVite.viteHost ?? "localhost");
        return;
      }

      const settledPort = detectPortFromText(recentOutput);
      if (settledPort) expose(settledPort);
    }, DETECTION_SETTLE_MS);
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
  if (detectionTimer) clearTimeout(detectionTimer);
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

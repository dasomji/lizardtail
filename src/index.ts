#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
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
  public: boolean;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_TAILSCALE_HTTPS_PORT = 8443;
const MAX_AUTO_TAILSCALE_HTTPS_PORT = 8999;
const FORBIDDEN_NICK_LOCAL_PORTS = new Set([80, 443, 8000, 6001, 6002]);
const DETECTION_SETTLE_MS = 1_500;

export function printUsage(): void {
  console.error(`Usage: lizardtail [options] -- <command> [args...]
       lizardtail [options] <command> [args...]

Options:
  --port <port>        Expose this port instead of detecting one from output.
  --host <host>        Local host to expose. Default: 127.0.0.1
  --timeout <ms>       Port-detection timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --tailscale-port <port>
                       Expose the main app on this Tailscale HTTPS port. Default: first free ${DEFAULT_TAILSCALE_HTTPS_PORT}+ port.
  --vite-tailscale-port <port>
                       Expose a detected Laravel Vite server on this Tailscale HTTPS port.
  --public, --funnel   Expose publicly on the internet with Tailscale Funnel instead of private tailnet-only Serve.
  --no-open-check      Skip waiting for the local port to accept connections.
  -h, --help           Show this help.

Examples:
  lizardtail pnpm dev
  lizardtail --port 3000 npm run dev
  lizardtail --tailscale-port 8450 pnpm dev
  lizardtail --public pnpm dev
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
    public: false,
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

    if (arg === "--public" || arg === "--funnel") {
      options.public = true;
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
  return message.includes("access denied") && (message.includes("sudo tailscale serve") || message.includes("sudo tailscale funnel") || message.includes("operator"));
}

type ExposureMode = "serve" | "funnel";

function tailscaleExposeCommand(target: string, tailscalePort: number, mode: ExposureMode): string[] {
  return [mode, "--bg", "--https", String(tailscalePort), target];
}

function tailscaleUrl(dnsName: string, tailscalePort?: number): string {
  return tailscalePort === undefined ? `https://${dnsName}` : `https://${dnsName}:${tailscalePort}`;
}

function tailscaleServePermissionHelp(target: string, tailscalePort: number, mode: ExposureMode): string {
  const label = mode === "funnel" ? "Funnel" : "Serve";
  return `Tailscale refused to update ${label} config without elevated privileges.

Run this once to let your user manage Tailscale ${label}:

  sudo tailscale set --operator=$USER

Then rerun lizardtail.

Or expose this server manually with:

  sudo tailscale ${tailscaleExposeCommand(target, tailscalePort, mode).join(" ")}`;
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

  const [code, signal] = (await Promise.race([
    once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>,
    once(child, "error").then(([error]) => {
      throw error;
    }) as Promise<[number | null, NodeJS.Signals | null]>,
  ])) as [number | null, NodeJS.Signals | null];
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

interface TailscaleExposureStatus {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

async function getTailscaleExposureStatus(mode: ExposureMode): Promise<TailscaleExposureStatus | undefined> {
  try {
    const { stdout } = await exec("tailscale", [mode, "status", "--json"]);
    return JSON.parse(stdout) as TailscaleExposureStatus;
  } catch {
    return undefined;
  }
}

async function getTailscaleServeStatus(): Promise<TailscaleExposureStatus | undefined> {
  return getTailscaleExposureStatus("serve");
}

function collectTailscaleStatusPorts(status: TailscaleExposureStatus | undefined, usedPorts: Set<number>): void {
  if (!status?.Web) return;

  for (const key of Object.keys(status.Web)) {
    const match = key.match(/:(\d{2,5})$/);
    const port = match?.[1] ? validDetectedPort(match[1]) : undefined;
    if (port) usedPorts.add(port);
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

async function resolveTailscaleHttpsPort(_target: string, requestedPort?: number): Promise<number> {
  if (requestedPort !== undefined) return requestedPort;
  return chooseTailscaleHttpsPort();
}

async function chooseTailscaleHttpsPort(excludedPort?: number): Promise<number> {
  const usedPorts = new Set<number>();
  collectTailscaleStatusPorts(await getTailscaleExposureStatus("serve"), usedPorts);
  collectTailscaleStatusPorts(await getTailscaleExposureStatus("funnel"), usedPorts);

  for (let port = DEFAULT_TAILSCALE_HTTPS_PORT; port <= MAX_AUTO_TAILSCALE_HTTPS_PORT; port += 1) {
    if (port !== excludedPort && !usedPorts.has(port)) return port;
  }

  throw new Error("could not find an available Tailscale HTTPS port");
}

function assertSafeTailscaleHttpsPort(port: number): void {
  if (port === 443) {
    throw new Error("refusing to use Tailscale HTTPS port 443; Lizard Tail only uses explicit high ports so it cannot interfere with Coolify/Traefik");
  }

  if (port < DEFAULT_TAILSCALE_HTTPS_PORT) {
    throw new Error(`refusing to use Tailscale HTTPS port ${port}; choose an explicit high port (${DEFAULT_TAILSCALE_HTTPS_PORT}+)`);
  }
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

interface NickPreflight {
  isNick: boolean;
  reason?: string;
}

async function detectNickHost(): Promise<NickPreflight> {
  const hostname = await exec("hostname", []).then(({ stdout }) => stdout.trim()).catch(() => "");
  if (/^(coolify|nick)$/i.test(hostname)) return { isNick: true, reason: `hostname is ${hostname}` };

  const dockerProxy = await getCoolifyProxyStatus().catch(() => undefined);
  if (dockerProxy?.running) return { isNick: true, reason: "coolify-proxy container is present" };

  return { isNick: false };
}

async function getCoolifyProxyStatus(): Promise<{ available: boolean; running: boolean; output: string }> {
  try {
    const { stdout } = await exec("docker", ["ps", "--filter", "name=coolify-proxy", "--format", "{{.Names}} {{.Status}}"]);
    const output = stdout.trim();
    return { available: true, running: /coolify-proxy/i.test(output) && /\b(up|running|healthy)\b/i.test(output), output };
  } catch (error) {
    const message = errorMessage(error).toLowerCase();
    if (message.includes("no such file") || message.includes("not found") || message.includes("executable file not found")) {
      return { available: false, running: false, output: "" };
    }
    throw error;
  }
}

async function runNickPreflight(localPort: number, tailscalePort: number, mode: ExposureMode): Promise<void> {
  const nick = await detectNickHost();
  if (!nick.isNick) return;

  if (FORBIDDEN_NICK_LOCAL_PORTS.has(localPort)) {
    throw new Error(`refusing to expose local port ${localPort} on Nick; Coolify safety forbids ports 80, 443, 8000, 6001, and 6002`);
  }

  assertSafeTailscaleHttpsPort(tailscalePort);

  const dockerProxy = await getCoolifyProxyStatus();
  if (dockerProxy.available && !dockerProxy.running) {
    throw new Error("refusing to expose on Nick because docker is available but coolify-proxy is not running/healthy");
  }

  const { stdout: sockets } = await exec("ss", ["-tulpn"]);
  assertCoolifyRootPortsSafe(sockets, dockerProxy.running);

  await exec("tailscale", ["serve", "status"]);

  console.error(`lizardtail: Nick safety preflight passed (${nick.reason}); using explicit Tailscale ${mode === "funnel" ? "Funnel" : "Serve"} HTTPS port ${tailscalePort}`);
}

function assertCoolifyRootPortsSafe(socketOutput: string, coolifyProxyRunning: boolean): void {
  const unsafeLines = socketOutput
    .split(/\r?\n/)
    .filter((line) => socketLineUsesPort(line, 80) || socketLineUsesPort(line, 443))
    .filter((line) => {
      if (/\b(coolify|traefik|docker-proxy)\b/i.test(line)) return false;
      if (coolifyProxyRunning && !/users:\(/i.test(line)) return false;
      return true;
    });

  if (unsafeLines.length > 0) {
    throw new Error(`refusing to expose on Nick because ports 80/443 are not clearly owned by Coolify/Traefik:\n${unsafeLines.join("\n")}`);
  }
}

function socketLineUsesPort(line: string, port: number): boolean {
  return new RegExp(`(?:^|[\\s:])(?:\\*|0\\.0\\.0\\.0|127\\.0\\.0\\.1|\\[::\\]|::|\\S+):${port}(?:\\s|$)`).test(line);
}

async function runNickPostflight(exposures: TailscaleExposure[]): Promise<void> {
  const nick = await detectNickHost();
  if (!nick.isNick) return;

  for (const exposure of exposures) {
    assertSafeTailscaleHttpsPort(exposure.httpsPort);
    const result = await checkHttpsUrl(exposure.url);
    if (!result.ok) {
      throw new Error(`Nick postflight failed: ${exposure.url} was not reachable on HTTPS port ${exposure.httpsPort}: ${result.message}`);
    }
  }

  const coolify = await checkHttpsUrl("https://coolify.audiopoesis.com/login");
  if (coolify.statusCode === 521) {
    throw new Error("Nick postflight failed: https://coolify.audiopoesis.com/login returned Cloudflare 521");
  }

  console.error(`lizardtail: Nick postflight passed; Coolify login returned ${coolify.statusCode ?? "no HTTP status but not 521"}`);
  for (const exposure of exposures) {
    console.error(`lizardtail: cleanup command: tailscale ${exposure.mode} --https=${exposure.httpsPort} off`);
  }
}

async function checkHttpsUrl(url: string): Promise<{ ok: boolean; statusCode?: number; message: string }> {
  return new Promise((resolve) => {
    const request = httpsRequest(url, { method: "GET", rejectUnauthorized: false, timeout: 5_000 }, (response) => {
      response.resume();
      response.on("end", () => {
        const statusCode = response.statusCode;
        resolve({ ok: statusCode !== undefined && statusCode >= 200 && statusCode < 500, statusCode, message: `HTTP ${statusCode ?? "unknown"}` });
      });
    });

    request.on("timeout", () => {
      request.destroy();
      resolve({ ok: false, message: "timeout" });
    });
    request.on("error", (error) => resolve({ ok: false, message: error.message }));
    request.end();
  });
}

interface TailscaleExposure {
  url: string;
  httpsPort: number;
  mode: ExposureMode;
}

async function exposeWithTailscaleDetailed(host: string, port: number, tailscalePort?: number, publicExposure = false): Promise<TailscaleExposure> {
  await exec("tailscale", ["status"]);

  const target = `http://${host}:${port}`;
  const resolvedTailscalePort = await resolveTailscaleHttpsPort(target, tailscalePort);
  assertSafeTailscaleHttpsPort(resolvedTailscalePort);
  const mode: ExposureMode = publicExposure ? "funnel" : "serve";
  await runNickPreflight(port, resolvedTailscalePort, mode);

  try {
    await exec("tailscale", tailscaleExposeCommand(target, resolvedTailscalePort, mode));
  } catch (firstError) {
    if (isTailscaleServePermissionError(firstError)) {
      throw new Error(tailscaleServePermissionHelp(target, resolvedTailscalePort, mode));
    }

    if (host !== "127.0.0.1" && host !== "localhost") throw firstError;

    try {
      await exec("tailscale", tailscaleExposeCommand(String(port), resolvedTailscalePort, mode));
    } catch (fallbackError) {
      if (isTailscaleServePermissionError(fallbackError)) {
        throw new Error(tailscaleServePermissionHelp(target, resolvedTailscalePort, mode));
      }
      throw fallbackError;
    }
  }

  const { stdout } = await exec("tailscale", ["status", "--json"]);
  const status = JSON.parse(stdout) as { Self?: { DNSName?: string; TailscaleIPs?: string[] } };
  const dnsName = status.Self?.DNSName?.replace(/\.$/, "");

  if (dnsName) return { url: tailscaleUrl(dnsName, resolvedTailscalePort), httpsPort: resolvedTailscalePort, mode };

  const ip = status.Self?.TailscaleIPs?.find((value) => /^\d+\.\d+\.\d+\.\d+$/.test(value));
  if (ip) return { url: tailscaleUrl(ip, resolvedTailscalePort), httpsPort: resolvedTailscalePort, mode };

  throw new Error("could not determine this device's Tailscale DNS name or IP");
}

export async function exposeWithTailscale(host: string, port: number, tailscalePort?: number, publicExposure = false): Promise<string> {
  return (await exposeWithTailscaleDetailed(host, port, tailscalePort, publicExposure)).url;
}

async function removeTailscaleExposurePort(port: number, mode: ExposureMode): Promise<void> {
  assertSafeTailscaleHttpsPort(port);
  await exec("tailscale", [mode, `--https=${port}`, "off"]);
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
  const createdTailscalePorts = new Map<number, ExposureMode>();

  const cleanupTailscaleServe = async () => {
    for (const [port, mode] of createdTailscalePorts) {
      try {
        await removeTailscaleExposurePort(port, mode);
        console.error(`lizardtail: removed Tailscale ${mode === "funnel" ? "Funnel" : "Serve"} mapping on HTTPS port ${port}`);
      } catch (error) {
        console.error(`lizardtail: failed to remove Tailscale ${mode === "funnel" ? "Funnel" : "Serve"} mapping on HTTPS port ${port}: ${errorMessage(error)}`);
      }
    }
    createdTailscalePorts.clear();
  };

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
      const exposure = await exposeWithTailscaleDetailed(options.host, port, options.tailscalePort, options.public);
      createdTailscalePorts.set(exposure.httpsPort, exposure.mode);
      console.error(`lizardtail: serving via Tailscale: ${exposure.url}`);
      await runNickPostflight([exposure]);
      console.error("");
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

      const appExposure = await exposeWithTailscaleDetailed(options.host, appPort, options.tailscalePort, options.public);
      createdTailscalePorts.set(appExposure.httpsPort, appExposure.mode);
      const viteProxy = await startCorsProxy(viteHost, vitePort);
      const viteTailscalePort = options.viteTailscalePort ?? (await chooseTailscaleHttpsPort(appExposure.httpsPort));
      const viteExposure = await exposeWithTailscaleDetailed(viteProxy.host, viteProxy.port, viteTailscalePort, options.public);
      createdTailscalePorts.set(viteExposure.httpsPort, viteExposure.mode);
      const hotPath = await writeLaravelHotFile(viteExposure.url);

      console.error(`lizardtail: serving Laravel via Tailscale: ${appExposure.url}`);
      console.error(`lizardtail: serving Vite assets via Tailscale: ${viteExposure.url}`);
      console.error(`lizardtail: proxying Vite through local CORS proxy: http://${viteProxy.host}:${viteProxy.port} -> ${viteLocalUrl}`);
      if (hotPath) console.error(`lizardtail: wrote Laravel Vite hot file: ${hotPath}`);
      await runNickPostflight([appExposure, viteExposure]);
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
  await cleanupTailscaleServe();

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

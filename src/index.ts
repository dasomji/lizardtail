#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
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
  public: boolean;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_TAILSCALE_HTTPS_PORT = 8443;
const MAX_AUTO_TAILSCALE_HTTPS_PORT = 8999;
const CONFIG_FILENAMES = ["lizardtail.config.json", ".lizardtail.json"];
const DETECTION_SETTLE_MS = 1_500;

type BlockedPortScope = "local" | "tailscale" | "both";

interface BlockedPortRule {
  port: number;
  scope?: BlockedPortScope;
  reason: string;
}

interface LizardtailConfig {
  blockedPorts: BlockedPortRule[];
}

const DEFAULT_CONFIG: LizardtailConfig = {
  blockedPorts: [
    {
      port: 80,
      scope: "both",
      reason: "Common HTTP ingress/proxy port. Blocking prevents dev exposure from replacing a production web route.",
    },
    {
      port: 443,
      scope: "both",
      reason: "Common HTTPS ingress/proxy port. Lizard Tail defaults to high explicit Tailscale HTTPS ports instead.",
    },
  ],
};

export function printUsage(): void {
  console.error(`Usage: lizardtail [options] -- <command> [args...]
       lizardtail [options] <command> [args...]
       lizardtail help [topic]
       lizardtail config init

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
  lizardtail help config
`);
}

function printDetailedHelp(topic?: string): void {
  if (topic === "config") {
    console.log(`Lizard Tail configuration

Config files, searched from the current working directory:
  1. lizardtail.config.json
  2. .lizardtail.json

You can also set LIZARDTAIL_CONFIG=/path/to/config.json.

Create a starter config:
  lizardtail config init

Config shape:
${JSON.stringify(DEFAULT_CONFIG, null, 2)}

blockedPorts entries:
  port    Number from 1 to 65535.
  scope   "local", "tailscale", or "both". Defaults to "both".
  reason  Human-readable explanation shown when the rule blocks an action.

If a config file exists, its blockedPorts list replaces the built-in default list. Keep the default entries if they matter for your host, or edit/remove them if your environment is different.`);
    return;
  }

  console.log(`Lizard Tail

Run a dev server command, detect its local port, and expose it through Tailscale.

Common usage:
  lizardtail pnpm dev
  lizardtail --port 3000 npm run dev
  lizardtail --tailscale-port 8450 pnpm dev
  lizardtail --public pnpm dev

Private vs public:
  Default: private tailnet-only Tailscale Serve.
  --public / --funnel: public internet exposure through Tailscale Funnel.

Safety:
  Lizard Tail always uses explicit high Tailscale HTTPS ports by default (${DEFAULT_TAILSCALE_HTTPS_PORT}+).
  It never runs bare tailscale serve/funnel target commands.
  It only removes mappings it created in the current process.
  Ports can be blocked with lizardtail.config.json or .lizardtail.json.

Help topics:
  lizardtail help config

Other commands:
  lizardtail config init      Write a starter config file.
`);
}

function usage(): never {
  printUsage();
  process.exit(2);
}

async function handleMetaCommand(argv: string[]): Promise<boolean> {
  if (argv[0] === "help") {
    printDetailedHelp(argv[1]);
    return true;
  }

  if (argv[0] === "config" && argv[1] === "init") {
    await writeDefaultConfigFile();
    return true;
  }

  if (argv[0] === "init-config") {
    await writeDefaultConfigFile();
    return true;
  }

  return false;
}

async function writeDefaultConfigFile(): Promise<void> {
  const configPath = path.join(process.cwd(), "lizardtail.config.json");
  if (existsSync(configPath)) throw new Error(`${configPath} already exists`);

  await writeFile(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  console.log(`wrote ${configPath}`);
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

async function loadConfig(): Promise<LizardtailConfig> {
  const configPath = findConfigPath();
  if (!configPath) return DEFAULT_CONFIG;

  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LizardtailConfig>;
    return normalizeConfig(parsed, configPath);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`failed to parse ${configPath}: ${error.message}`);
    throw error;
  }
}

function findConfigPath(): string | undefined {
  if (process.env.LIZARDTAIL_CONFIG) return process.env.LIZARDTAIL_CONFIG;

  for (const filename of CONFIG_FILENAMES) {
    const candidate = path.join(process.cwd(), filename);
    if (existsSync(candidate)) return candidate;
  }

  return undefined;
}

function normalizeConfig(config: Partial<LizardtailConfig>, source: string): LizardtailConfig {
  if (!Array.isArray(config.blockedPorts)) {
    throw new Error(`${source} must contain a blockedPorts array`);
  }

  return {
    blockedPorts: config.blockedPorts.map((rule, index) => normalizeBlockedPortRule(rule, `${source}:blockedPorts[${index}]`)),
  };
}

function normalizeBlockedPortRule(rule: Partial<BlockedPortRule>, label: string): BlockedPortRule {
  const port = Number(rule.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label}.port must be an integer from 1 to 65535`);
  }

  const scope = rule.scope ?? "both";
  if (scope !== "local" && scope !== "tailscale" && scope !== "both") {
    throw new Error(`${label}.scope must be "local", "tailscale", or "both"`);
  }

  const reason = typeof rule.reason === "string" && rule.reason.trim() ? rule.reason.trim() : "Blocked by lizardtail configuration.";
  return { port, scope, reason };
}

function findBlockedPortRule(config: LizardtailConfig, port: number, scope: Exclude<BlockedPortScope, "both">): BlockedPortRule | undefined {
  return config.blockedPorts.find((rule) => rule.port === port && (rule.scope === "both" || rule.scope === scope || rule.scope === undefined));
}

function assertPortAllowed(config: LizardtailConfig, port: number, scope: Exclude<BlockedPortScope, "both">): void {
  const rule = findBlockedPortRule(config, port, scope);
  if (!rule) return;

  const label = scope === "tailscale" ? "Tailscale HTTPS" : "local";
  throw new Error(`refusing to use ${label} port ${port}: ${rule.reason}`);
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

function collectTailscaleStatusPorts(status: TailscaleExposureStatus | undefined, usedPorts: Set<number>): void {
  if (!status?.Web) return;

  for (const key of Object.keys(status.Web)) {
    const match = key.match(/:(\d{2,5})$/);
    const port = match?.[1] ? validDetectedPort(match[1]) : undefined;
    if (port) usedPorts.add(port);
  }
}

async function resolveTailscaleHttpsPort(_target: string, requestedPort?: number, config = DEFAULT_CONFIG): Promise<number> {
  if (requestedPort !== undefined) return requestedPort;
  return chooseTailscaleHttpsPort(undefined, config);
}

async function chooseTailscaleHttpsPort(excludedPort?: number, config = DEFAULT_CONFIG): Promise<number> {
  const usedPorts = new Set<number>();
  collectTailscaleStatusPorts(await getTailscaleExposureStatus("serve"), usedPorts);
  collectTailscaleStatusPorts(await getTailscaleExposureStatus("funnel"), usedPorts);

  for (let port = DEFAULT_TAILSCALE_HTTPS_PORT; port <= MAX_AUTO_TAILSCALE_HTTPS_PORT; port += 1) {
    if (port === excludedPort || usedPorts.has(port) || findBlockedPortRule(config, port, "tailscale")) continue;
    return port;
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

interface TailscaleExposure {
  url: string;
  httpsPort: number;
  mode: ExposureMode;
}

async function exposeWithTailscaleDetailed(host: string, port: number, tailscalePort?: number, publicExposure = false, config?: LizardtailConfig): Promise<TailscaleExposure> {
  const resolvedConfig = config ?? (await loadConfig());
  assertPortAllowed(resolvedConfig, port, "local");
  await exec("tailscale", ["status"]);

  const target = `http://${host}:${port}`;
  const resolvedTailscalePort = await resolveTailscaleHttpsPort(target, tailscalePort, resolvedConfig);
  assertPortAllowed(resolvedConfig, resolvedTailscalePort, "tailscale");
  const mode: ExposureMode = publicExposure ? "funnel" : "serve";

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
  await exec("tailscale", [mode, `--https=${port}`, "off"]);
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (await handleMetaCommand(argv)) return;

  const options = parseArgs(argv);
  const config = await loadConfig();
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
      assertPortAllowed(config, port, "local");
      if (options.openCheck) await waitForOpenPort(options.host, port, 10_000);
      const exposure = await exposeWithTailscaleDetailed(options.host, port, options.tailscalePort, options.public, config);
      createdTailscalePorts.set(exposure.httpsPort, exposure.mode);
      console.error(`lizardtail: serving via Tailscale: ${exposure.url}`);
      console.error(`lizardtail: cleanup command: tailscale ${exposure.mode} --https=${exposure.httpsPort} off`);
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
      assertPortAllowed(config, appPort, "local");
      assertPortAllowed(config, vitePort, "local");

      if (options.openCheck) {
        await waitForOpenPort(options.host, appPort, 10_000);
        await waitForOpenPort(viteHost, vitePort, 10_000);
      }

      const appExposure = await exposeWithTailscaleDetailed(options.host, appPort, options.tailscalePort, options.public, config);
      createdTailscalePorts.set(appExposure.httpsPort, appExposure.mode);
      const viteProxy = await startCorsProxy(viteHost, vitePort);
      const viteTailscalePort = options.viteTailscalePort ?? (await chooseTailscaleHttpsPort(appExposure.httpsPort, config));
      const viteExposure = await exposeWithTailscaleDetailed(viteProxy.host, viteProxy.port, viteTailscalePort, options.public, config);
      createdTailscalePorts.set(viteExposure.httpsPort, viteExposure.mode);
      const hotPath = await writeLaravelHotFile(viteExposure.url);

      console.error(`lizardtail: serving Laravel via Tailscale: ${appExposure.url}`);
      console.error(`lizardtail: serving Vite assets via Tailscale: ${viteExposure.url}`);
      console.error(`lizardtail: proxying Vite through local CORS proxy: http://${viteProxy.host}:${viteProxy.port} -> ${viteLocalUrl}`);
      if (hotPath) console.error(`lizardtail: wrote Laravel Vite hot file: ${hotPath}`);
      console.error(`lizardtail: cleanup command: tailscale ${appExposure.mode} --https=${appExposure.httpsPort} off`);
      console.error(`lizardtail: cleanup command: tailscale ${viteExposure.mode} --https=${viteExposure.httpsPort} off`);
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

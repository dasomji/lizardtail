import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { hostPath, exists, type Plan } from "./system.js";
let cached: { file: string; token: string; expires: number } | undefined;
async function privateFile(file: string) {
  if ((await stat(file)).mode & 0o077)
    throw Error("Tailscale credential file must be private (chmod 600)");
  return readFile(file, "utf8");
}

// API shape verified against tailscale/internal/client/tailscale/vip_service.go.
export async function apiToken(): Promise<string> {
  const oauthFile = path.join(path.dirname(hostPath()), "tailscale-oauth.json");
  if (await exists(oauthFile)) {
    if (cached?.file === oauthFile && cached.expires > Date.now())
      return cached.token;
    const credentials = JSON.parse(await privateFile(oauthFile));
    if (!credentials.clientId || !credentials.clientSecret)
      throw Error("OAuth file needs clientId and clientSecret");
    const response = await fetch(
      "https://api.tailscale.com/api/v2/oauth/token",
      {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) throw Error(`Tailscale OAuth: HTTP ${response.status}`);
    const result = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!result.access_token || !result.expires_in)
      throw Error("Invalid OAuth token response");
    cached = {
      file: oauthFile,
      token: result.access_token,
      expires: Date.now() + Math.max(0, result.expires_in - 60) * 1000,
    };
    return result.access_token;
  }
  const file = path.join(path.dirname(hostPath()), "tailscale-token");
  const token = (await privateFile(file)).trim();
  if (!token || /\s/.test(token)) throw Error("Invalid Tailscale token file");
  return token;
}
export async function serviceRequest(
  name: string,
  method = "GET",
  body?: unknown,
) {
  const token = await apiToken();
  const response = await fetch(
    `https://api.tailscale.com/api/v2/tailnet/-/vip-services/${encodeURIComponent(name)}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    },
  );
  if (method === "GET" && response.status === 404) return undefined;
  if (!response.ok)
    throw Error(`Tailscale Services API ${method}: HTTP ${response.status}`);
  return method === "GET" ? response.json() : undefined;
}
export async function ensureServices(p: Plan) {
  if (p.host.exposure !== "service") return;
  for (const name of Object.values(p.names)) {
    const key = "svc:" + name;
    const comment = `lizardtail:${p.id}`;
    const existing = await serviceRequest(key);
    if (existing) {
      if (existing.comment !== comment || !existing.ports?.includes("tcp:443"))
        throw Error(`Service ${key} is not the expected Lizardtail resource`);
    } else {
      await serviceRequest(key, "PUT", {
        name: key,
        comment,
        ports: ["tcp:443"],
        tags: ["tag:lizardtail-preview"],
      });
      const created = await serviceRequest(key);
      if (created?.comment !== comment)
        throw Error(`Service ${key} creation could not be verified`);
    }
  }
}
// Definitions remain after down so their identity is stable. Finish removes only
// resources bearing this instance's ownership marker, never a replaced service.
export async function deleteServices(p: Plan) {
  if (p.host.exposure !== "service") return;
  for (const name of Object.values(p.names)) {
    const key = "svc:" + name;
    const existing = await serviceRequest(key);
    if (!existing) continue;
    if (existing.comment !== `lizardtail:${p.id}`)
      throw Error(`Refusing foreign Service ${key}`);
    await serviceRequest(key, "DELETE");
  }
}

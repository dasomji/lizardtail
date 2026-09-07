#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { startBridge, stopBridges } from "../dist/managed/bridge.js";
import { free } from "../dist/managed/system.js";
const root = await mkdtemp(path.join(os.tmpdir(), "lt-bridge-"));
let port = 25000;
while (!(await free(port))) port++;
const b = {
  unit: `lizardtail-${randomBytes(8).toString("hex")}-abcdef-${randomBytes(8).toString("hex")}`,
  port,
  socket: path.join(root, "app.sock"),
};
const server = http.createServer((q, r) => r.end("owned-gateway"));
try {
  await new Promise((r) => server.listen(b.socket, r));
  await startBridge(b);
  assert.equal(
    await (
      await fetch(`http://127.0.0.1:${port}`, {
        headers: { Connection: "close" },
      })
    ).text(),
    "owned-gateway",
  );
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  assert.equal(
    await free(port),
    false,
    "socket unit must retain port after upstream failure",
  );
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(2000) }),
  );
  await stopBridges([b]);
  assert.equal(await free(port), true);
  await stopBridges([b]);
  console.log(
    "PASS: socket proxy routes correctly, reserves port after upstream crash, releases only on cleanup",
  );
} finally {
  server.closeAllConnections();
  server.close();
  await stopBridges([b]);
  await rm(root, { recursive: true, force: true });
}

#!/usr/bin/env node
// Disposable real PostgreSQL/S3 integration test; destroys only its labeled resources.
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
const root = await mkdtemp(path.join(os.tmpdir(), "lt-data-"));
process.env.LIZARDTAIL_STATE_DIR = path.join(root, "s");
process.env.LIZARDTAIL_HOST_CONFIG = path.join(root, "host.json");
const { plan, up, down } = await import("../dist/managed/cli.js");
const {
  startDatabase,
  markDatabase,
  docker,
  startStorage,
  storageClient,
  stopResources,
  credentials,
} = await import("../dist/managed/resources.js");
const reference = {
  database: {
    image:
      "postgres:17-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0",
  },
  storage: {
    image:
      "chrislusf/seaweedfs:4.45@sha256:fc9f76fa993ad69966ffeb2f65d0318fcae39c6f8e20cf68ef7b3a5cb97769e5",
  },
};
await writeFile(
  process.env.LIZARDTAIL_HOST_CONFIG,
  JSON.stringify({
    exposure: "none",
    caddy: process.env.CADDY_BIN ?? "caddy",
    portMin: 24000,
    portMax: 24999,
  }),
);
await writeFile(
  path.join(root, "lizardtail.project.json"),
  JSON.stringify({
    version: 1,
    project: "smoke-data",
    database: {
      kind: "postgres",
      image: reference.database.image,
      migrate: ["true"],
    },
    storage: reference.storage,
    services: {
      web: {
        command: [
          "node",
          "-e",
          "require('http').createServer((q,r)=>r.end('ready')).listen(Number(process.env.PORT),'127.0.0.1')",
        ],
        port: true,
        env: { PORT: "${port.web}" },
      },
    },
    endpoints: {
      app: { routes: [{ path: "/", service: "web" }] },
      storage: { routes: [{ path: "/", service: "storage" }] },
    },
  }),
);
const plans = [];
const clients = [];
const sql = (p, q) =>
  docker(
    p,
    [
      "exec",
      "-i",
      `lizardtail-${p.id}-db`,
      "psql",
      "-X",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "app",
    ],
    q,
  );
try {
  const main = await plan(root, "main");
  plans.push(main);
  await startDatabase(main);
  await sql(
    main,
    "CREATE TABLE sample (value text); INSERT INTO sample VALUES ('main-data');",
  );
  await markDatabase(main);
  await startStorage(main);
  const a = await storageClient(main);
  clients.push(a);
  await a.send(
    new PutObjectCommand({
      Bucket: "assets",
      Key: "a.txt",
      Body: "main-asset",
      ContentType: "text/plain",
    }),
  );
  const feature = await plan(root, "feature");
  plans.push(feature);
  await startDatabase(feature);
  assert.equal(
    (await sql(feature, "SELECT value FROM sample")).trim(),
    "main-data",
  );
  await sql(feature, "UPDATE sample SET value='feature-data'");
  assert.equal(
    (await sql(main, "SELECT value FROM sample")).trim(),
    "main-data",
  );
  await startStorage(feature);
  await up(main);
  await up(feature);
  const secret = await credentials(feature);
  const b = new S3Client({
    endpoint: feature.origins.storage,
    region: "us-east-1",
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: { accessKeyId: secret.access, secretAccessKey: secret.secret },
  });
  clients.push(b);
  assert.equal(
    await (
      await b.send(new GetObjectCommand({ Bucket: "assets", Key: "a.txt" }))
    ).Body.transformToString(),
    "main-asset",
  );
  const put = await getSignedUrl(
    b,
    new PutObjectCommand({
      Bucket: "assets",
      Key: "a.txt",
      ContentType: "text/plain",
    }),
    { expiresIn: 60 },
  );
  const uploaded = await fetch(put, {
    method: "PUT",
    body: "feature-asset",
    headers: { "Content-Type": "text/plain" },
  });
  assert.equal(uploaded.status, 200, await uploaded.text());
  const get = await getSignedUrl(
    b,
    new GetObjectCommand({ Bucket: "assets", Key: "a.txt" }),
    { expiresIn: 60 },
  );
  assert.equal(await (await fetch(get)).text(), "feature-asset");
  assert.equal(
    await (
      await a.send(new GetObjectCommand({ Bucket: "assets", Key: "a.txt" }))
    ).Body.transformToString(),
    "main-asset",
  );
  const cors = await fetch(feature.origins.storage + "/assets/a.txt", {
    method: "OPTIONS",
    headers: {
      Origin: feature.origins.app,
      "Access-Control-Request-Method": "PUT",
    },
  });
  assert.equal(
    cors.headers.get("access-control-allow-origin"),
    feature.origins.app,
  );
  await down(feature);
  await up(feature);
  assert.equal(
    (await sql(feature, "SELECT value FROM sample")).trim(),
    "feature-data",
  );
  assert.equal(
    await (
      await b.send(new GetObjectCommand({ Bucket: "assets", Key: "a.txt" }))
    ).Body.transformToString(),
    "feature-asset",
  );
  console.log(
    "PASS: PostgreSQL clone isolation, persistent stop/resume, S3 clone isolation, signed PUT/GET through Caddy, browser CORS",
  );
} finally {
  for (const c of clients) c.destroy();
  for (const p of plans.reverse()) {
    await down(p);
    await stopResources(p, true);
  }
  await rm(root, { recursive: true, force: true });
}

import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import {
  S3Client,
  PutBucketCorsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { run, json, atomic, exists, registry, type Plan } from "./system.js";
export const docker = (p: Plan, args: string[], input?: string) =>
  run("docker", ["--context", p.host.dockerContext, ...args], {
    input,
    timeout: 300000,
  });
const name = (p: Plan, kind: string) => `lizardtail-${p.id}-${kind}`;
export async function rootless(p: Plan) {
  const data = JSON.parse(
    await docker(p, ["info", "--format", "{{json .SecurityOptions}}"]),
  );
  if (!Array.isArray(data) || !data.some((s: string) => s.includes("rootless")))
    throw Error(
      "Lizardtail requires a rootless Docker context; do not grant agents the rootful Docker socket",
    );
}
async function inspect(p: Plan, kind: string, type = "container") {
  try {
    return JSON.parse(await docker(p, [type, "inspect", name(p, kind)]))[0];
  } catch (e) {
    if (/no such (container|object|volume)/i.test(String(e))) return undefined;
    throw e;
  }
}
function owned(p: Plan, x: any, volume = false) {
  const labels = volume ? x.Labels : x.Config?.Labels;
  if (labels?.["dev.lizardtail.instance"] !== p.id)
    throw Error("Refusing foreign Docker resource");
}
async function provision(
  p: Plan,
  kind: string,
  image: string,
  port: number,
  internal: number,
  env: Record<string, string>,
  args: string[] = [],
) {
  const volumePath =
    kind === "db"
      ? (p.project.database?.volumePath ?? "/var/lib/postgresql/data")
      : "/data";
  let c = await inspect(p, kind);
  if (c) {
    owned(p, c);
    if (c.Config.Image !== image)
      throw Error(`${kind}: image changed; explicit data upgrade required`);
    if (
      !c.Mounts?.some(
        (m: any) => m.Name === name(p, kind) && m.Destination === volumePath,
      )
    )
      throw Error(
        `${kind}: volume mount changed; explicit data upgrade required`,
      );
    if (!c.State.Running) await docker(p, ["start", name(p, kind)]);
    return;
  }
  const v = await inspect(p, kind, "volume");
  if (v) owned(p, v, true);
  else
    await docker(p, [
      "volume",
      "create",
      "--label",
      `dev.lizardtail.instance=${p.id}`,
      name(p, kind),
    ]);
  const envFile = path.join(p.dir, kind + ".env");
  await writeFile(
    envFile,
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    { mode: 0o600 },
  );
  await docker(p, [
    "run",
    "-d",
    "--name",
    name(p, kind),
    "--label",
    `dev.lizardtail.instance=${p.id}`,
    "--env-file",
    envFile,
    "--publish",
    `127.0.0.1:${port}:${internal}`,
    "--mount",
    `type=volume,src=${name(p, kind)},dst=${volumePath}`,
    image,
    ...args,
  ]);
}
export async function credentials(p: Plan) {
  const file = path.join(p.dir, "credentials.json");
  if (!(await exists(file)))
    await atomic(file, {
      password: randomBytes(24).toString("hex"),
      access: randomBytes(12).toString("hex"),
      secret: randomBytes(24).toString("hex"),
    });
  return json<{ password: string; access: string; secret: string }>(file);
}
export async function values(p: Plan) {
  const result: Record<string, string> = { root: p.root, instance: p.instance };
  for (const [k, v] of Object.entries(p.ports)) result["port." + k] = String(v);
  for (const [k, v] of Object.entries(p.origins)) {
    result["origin." + k] = v;
    result["hostname." + k] = new URL(v).hostname;
  }
  const c = await credentials(p);
  if (p.project.database?.kind === "postgres") {
    result["database.url"] =
      `postgresql://postgres:${c.password}@127.0.0.1:${p.ports.db}/app`;
    result["database.password"] = c.password;
    result["database.name"] = "app";
  } else if (p.project.database) {
    result["database.path"] = path.join(p.dir, "database.sqlite");
    result["database.url"] = "sqlite://" + result["database.path"];
  }
  if (p.project.storage) {
    result["storage.bucket"] = "assets";
    result["storage.accessKey"] = c.access;
    result["storage.secretKey"] = c.secret;
    result["storage.internalEndpoint"] = `http://127.0.0.1:${p.ports.storage}`;
    result["storage.endpoint"] =
      p.origins.storage ?? result["storage.internalEndpoint"];
  }
  return result;
}
async function mainPlan(p: Plan) {
  const r = await registry();
  const source = Object.values(r.instances).find(
    (x) =>
      x.common === p.common &&
      x.project.project === p.project.project &&
      x.instance === "main",
  );
  if (!source)
    throw Error("Register and initialize main before creating feature data");
  return source;
}
export async function startDatabase(p: Plan) {
  if (!p.project.database) return;
  const db = p.project.database;
  const readyFile = path.join(p.dir, "database.ready");
  if (db.kind === "sqlite") {
    if (!(await exists(readyFile))) {
      let source = db.source ? path.resolve(p.root, db.source) : undefined;
      if (p.instance !== "main") {
        const main = await mainPlan(p);
        if (!(await exists(path.join(main.dir, "database.ready"))))
          throw Error("Main database not initialized");
        source = path.join(main.dir, "database.sqlite");
      }
      if (!source || !(await exists(source)))
        throw Error("SQLite main needs an existing source file");
      await run("python3", [
        "-c",
        "import sqlite3,sys; s=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()",
        source,
        path.join(p.dir, "database.sqlite"),
      ]);
      await atomic(readyFile, { at: new Date().toISOString(), source });
    }
    return;
  }
  await rootless(p);
  const c = await credentials(p);
  await provision(p, "db", db.image!, p.ports.db, 5432, {
    POSTGRES_PASSWORD: c.password,
    POSTGRES_DB: "app",
  });
  for (let i = 0; ; i++) {
    try {
      await docker(p, [
        "exec",
        name(p, "db"),
        "pg_isready",
        "-U",
        "postgres",
        "-d",
        "app",
      ]);
      break;
    } catch (e) {
      if (i === 59) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!(await exists(readyFile)) && p.instance !== "main") {
    const main = await mainPlan(p);
    if (!(await exists(path.join(main.dir, "database.ready"))))
      throw Error("Import or initialize main first");
    await startDatabase(main);
    const dump = await dumpDatabase(main);
    await restore(p, dump);
    await atomic(readyFile, { at: new Date().toISOString(), source: main.id });
  }
}
export async function dumpDatabase(p: Plan) {
  return docker(p, [
    "exec",
    name(p, "db"),
    "pg_dump",
    "-U",
    "postgres",
    "-d",
    "app",
    "--no-owner",
    "--no-acl",
  ]);
}
export async function restore(p: Plan, dump: string) {
  await docker(p, [
    "exec",
    name(p, "db"),
    "dropdb",
    "-U",
    "postgres",
    "--if-exists",
    "app",
  ]);
  await docker(p, ["exec", name(p, "db"), "createdb", "-U", "postgres", "app"]);
  await docker(
    p,
    [
      "exec",
      "-i",
      name(p, "db"),
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "app",
    ],
    dump,
  );
}
export async function markDatabase(p: Plan) {
  if (p.project.database)
    await atomic(path.join(p.dir, "database.ready"), {
      at: new Date().toISOString(),
    });
}
export async function importDatabase(p: Plan, file: string, key: string) {
  if (p.instance !== "main" || p.project.database?.kind !== "postgres")
    throw Error("Import is only allowed into an uninitialized PostgreSQL main");
  if (await exists(path.join(p.dir, "database.ready")))
    throw Error("Main already initialized; refusing replacement");
  await startDatabase(p);
  const env = parseEnv(await readFile(file, "utf8"));
  if (!env[key]) throw Error(`Missing ${key}`);
  const url = new URL(env[key]);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw Error("Expected PostgreSQL URL");
  const remoteFile = path.join(p.dir, "import.env");
  const caFile = `/tmp/lizardtail-import-${p.id}.crt`;
  const sourceCA = url.searchParams.get("sslrootcert");
  await docker(p, [
    "cp",
    sourceCA && sourceCA !== "system"
      ? path.resolve(path.dirname(file), sourceCA)
      : "/etc/ssl/certs/ca-certificates.crt",
    `${name(p, "db")}:${caFile}`,
  ]);
  await writeFile(
    remoteFile,
    Object.entries({
      PGHOST: url.hostname.endsWith(".neon.tech")
        ? url.hostname.replace("-pooler.", ".")
        : url.hostname,
      PGPORT: url.port || "5432",
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGSSLMODE: url.searchParams.get("sslmode") ?? "require",
      PGSSLROOTCERT: caFile,
    })
      .map(([k, v]) => {
        if (/[\r\n]/.test(v)) throw Error("Invalid connection value");
        return `${k}=${v}`;
      })
      .join("\n"),
    { mode: 0o600 },
  );
  try {
    const dump = await docker(p, [
      "exec",
      "--env-file",
      remoteFile,
      name(p, "db"),
      "pg_dump",
      "--no-owner",
      "--no-acl",
    ]);
    await writeFile(path.join(p.dir, "import.sql"), dump, { mode: 0o600 });
    await restore(p, dump);
    await markDatabase(p);
  } finally {
    await rm(remoteFile, { force: true });
    await docker(p, ["exec", name(p, "db"), "rm", "-f", caFile]);
  }
}
export async function importDump(p: Plan, file: string) {
  if (p.instance !== "main" || p.project.database?.kind !== "postgres")
    throw Error("Dump import requires PostgreSQL main");
  if (await exists(path.join(p.dir, "database.ready")))
    throw Error("Main already initialized; refusing replacement");
  const dump = await readFile(file, "utf8");
  if (!dump.includes("PostgreSQL database dump"))
    throw Error("Expected a plain SQL pg_dump file");
  await startDatabase(p);
  await writeFile(path.join(p.dir, "import.sql"), dump, { mode: 0o600 });
  await restore(p, dump);
  await markDatabase(p);
}
export async function storageClient(p: Plan) {
  const c = await credentials(p);
  return new S3Client({
    endpoint: `http://127.0.0.1:${p.ports.storage}`,
    region: "us-east-1",
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: { accessKeyId: c.access, secretAccessKey: c.secret },
  });
}
export async function startStorage(p: Plan) {
  if (!p.project.storage) return;
  await rootless(p);
  const c = await credentials(p);
  await provision(
    p,
    "storage",
    p.project.storage.image,
    p.ports.storage,
    8333,
    {
      AWS_ACCESS_KEY_ID: c.access,
      AWS_SECRET_ACCESS_KEY: c.secret,
      S3_BUCKET: "assets",
    },
    ["mini", "-dir=/data"],
  );
  const client = await storageClient(p);
  for (let i = 0; ; i++) {
    try {
      await client.send(
        new ListObjectsV2Command({ Bucket: "assets", MaxKeys: 1 }),
      );
      break;
    } catch (e) {
      if (i === 59) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  await client.send(
    new PutBucketCorsCommand({
      Bucket: "assets",
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: Object.entries(p.origins)
              .filter(([k]) => k !== "storage")
              .map(([, v]) => v),
            AllowedMethods: ["GET", "HEAD", "PUT", "POST", "DELETE"],
            AllowedHeaders: ["*"],
            ExposeHeaders: ["ETag"],
            MaxAgeSeconds: 300,
          },
        ],
      },
    }),
  );
  // Independent stores: clone objects through SDK streams so no shared write path exists.
  if (
    p.instance !== "main" &&
    !(await exists(path.join(p.dir, "storage.ready")))
  ) {
    const main = await mainPlan(p);
    await startStorage(main);
    const source = await storageClient(main);
    const { GetObjectCommand, PutObjectCommand } =
      await import("@aws-sdk/client-s3");
    let token: string | undefined;
    do {
      const page = await source.send(
        new ListObjectsV2Command({
          Bucket: "assets",
          ContinuationToken: token,
        }),
      );
      for (const o of page.Contents ?? []) {
        if (!o.Key) continue;
        const obj = await source.send(
          new GetObjectCommand({ Bucket: "assets", Key: o.Key }),
        );
        await client.send(
          new PutObjectCommand({
            Bucket: "assets",
            Key: o.Key,
            Body: obj.Body as Readable,
            ContentLength: obj.ContentLength,
            ContentType: obj.ContentType,
            CacheControl: obj.CacheControl,
            ContentDisposition: obj.ContentDisposition,
            Metadata: obj.Metadata,
          }),
        );
      }
      token = page.NextContinuationToken;
    } while (token);
    source.destroy();
  }
  await atomic(path.join(p.dir, "storage.ready"), {
    at: new Date().toISOString(),
  });
  client.destroy();
}
export async function stopResources(p: Plan, destroy = false) {
  for (const kind of ["storage", "db"]) {
    if (
      (kind === "db" && p.project.database?.kind !== "postgres") ||
      (kind === "storage" && !p.project.storage)
    )
      continue;
    const c = await inspect(p, kind);
    if (c) {
      owned(p, c);
      await docker(p, ["stop", "--time", "10", name(p, kind)]);
      if (destroy) await docker(p, ["rm", name(p, kind)]);
    }
    if (destroy) {
      const v = await inspect(p, kind, "volume");
      if (v) {
        owned(p, v, true);
        await docker(p, ["volume", "rm", name(p, kind)]);
      }
    }
  }
  if (destroy && p.project.database?.kind === "sqlite")
    await rm(path.join(p.dir, "database.sqlite"), { force: true });
}

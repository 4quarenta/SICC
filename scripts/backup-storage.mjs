#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { pipeline } from "node:stream/promises";

const supabaseUrl = String(process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const bucket = String(process.env.SICC_STORAGE_BUCKET || "sicc-media");
const outputDir = process.env.BACKUP_STORAGE_DIR ?? "backup-source/storage";

if (!supabaseUrl || !serviceRoleKey || !bucket) {
  throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY e SICC_STORAGE_BUCKET são obrigatórios.");
}

const headers = {
  apikey: serviceRoleKey,
  authorization: `Bearer ${serviceRoleKey}`,
};

function storagePath(path) {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

async function listPage(prefix, offset) {
  const response = await fetch(`${supabaseUrl}/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ prefix, limit: 100, offset, sortBy: { column: "name", order: "asc" } }),
  });
  if (!response.ok) throw new Error(`Falha ao listar Storage (${response.status}): ${await response.text()}`);
  return await response.json();
}

async function listFiles(prefix = "") {
  const files = [];
  for (let offset = 0; ; offset += 100) {
    const entries = await listPage(prefix, offset);
    if (!Array.isArray(entries) || entries.length === 0) break;
    for (const entry of entries) {
      const name = String(entry?.name ?? "");
      if (!name) continue;
      const path = `${prefix}${name}`;
      // Storage returns folders with id=null and files with an id/metadata.
      if (entry.id == null && entry.metadata == null) {
        files.push(...await listFiles(`${path}/`));
      } else {
        files.push(path);
      }
    }
    if (entries.length < 100) break;
  }
  return files;
}

async function downloadFile(objectPath) {
  const response = await fetch(`${supabaseUrl}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${storagePath(objectPath)}`, { headers });
  if (!response.ok) throw new Error(`Falha ao baixar ${objectPath} (${response.status}): ${await response.text()}`);
  const target = normalize(join(outputDir, objectPath));
  const root = normalize(outputDir + sep);
  if (!target.startsWith(root)) throw new Error(`Caminho de Storage inválido: ${objectPath}`);
  await mkdir(dirname(target), { recursive: true });
  await pipeline(response.body, createWriteStream(target));
  const bytes = await stat(target);
  const hash = createHash("sha256");
  const file = createReadStream(target);
  for await (const chunk of file) hash.update(chunk);
  return { path: objectPath, bytes: bytes.size, sha256: hash.digest("hex") };
}

const files = await listFiles();
await mkdir(outputDir, { recursive: true });
const manifest = [];
const queue = [...files];
const workers = Array.from({ length: 4 }, async () => {
  while (queue.length) {
    const objectPath = queue.shift();
    if (objectPath) manifest.push(await downloadFile(objectPath));
  }
});
await Promise.all(workers);
manifest.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(join(dirname(outputDir), "storage-manifest.json"), JSON.stringify({ bucket, files: manifest }, null, 2));
console.log(`Storage copiado: ${manifest.length} arquivo(s).`);

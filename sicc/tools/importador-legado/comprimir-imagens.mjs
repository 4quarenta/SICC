#!/usr/bin/env node

/**
 * Phase 2 of the local legacy import: compress every image referenced by the
 * extraction checkpoint. Originals are never modified. The operation is
 * resumable and stores only technical compression metadata in SQLite/manifest.
 */

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";

const DEFAULT_MAX_DIMENSION = 1600;
const DEFAULT_QUALITY = 78;

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function openCheckpoint(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 30000;");
  return db;
}

function compressionBuffer(input, { maxDimension, quality }) {
  return sharp(input, { failOn: "error" })
    .rotate()
    .resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true })
    .webp({ quality, effort: 6 })
    .toBuffer();
}

function updatePayload(db, row, payload, compressedBytes, imageFile, { maxDimension, quality }) {
  payload.imageFile = imageFile;
  payload.compressedBytes = compressedBytes;
  payload.savingsPercent = row.original_bytes
    ? Number(((1 - compressedBytes / row.original_bytes) * 100).toFixed(2))
    : null;
  payload.compressionStatus = "COMPRESSED";
  payload.compressionProfile = { format: "webp", maxDimension, quality, effort: 6 };
  db.prepare(`update files set compressed_bytes=?, payload=?, state=?, reason=?, updated_at=? where source_path=?`).run(
    compressedBytes,
    JSON.stringify(payload),
    row.state === "READY_FOR_COMPRESSION" ? "STAGED" : row.state,
    row.reason ?? null,
    new Date().toISOString(),
    row.source_path,
  );
}

async function run() {
  const args = process.argv.slice(2);
  const workDir = resolve(argValue(args, "--work", process.env.SICC_IMPORT_WORK_DIR ?? ""));
  if (!workDir) throw new Error("Informe --work com o diretório da fase 1.");
  const maxDimension = Number(argValue(args, "--max-dimension", String(DEFAULT_MAX_DIMENSION))) || DEFAULT_MAX_DIMENSION;
  const quality = Number(argValue(args, "--quality", String(DEFAULT_QUALITY))) || DEFAULT_QUALITY;
  const limit = Number(argValue(args, "--limit", "0")) || 0;
  const checkpointPath = join(workDir, "checkpoint.sqlite");
  const statusPath = join(workDir, "compression-status.json");
  const manifestPath = join(workDir, "manifest.json");
  const imagesDir = join(workDir, "images");
  await mkdir(imagesDir, { recursive: true });
  const db = openCheckpoint(checkpointPath);
  const allRows = db.prepare("select * from files where payload is not null order by source_path").all();
  const rows = limit ? allRows.slice(0, limit) : allRows;
  let processed = 0;
  let skipped = 0;
  let errors = 0;
  let originalBytes = 0;
  let compressedBytes = 0;

  const writeStatus = async (completed = false) => {
    await writeFile(statusPath, JSON.stringify({
      completed,
      sourceFileCount: allRows.length,
      selectedFileCount: rows.length,
      processed,
      remaining: Math.max(0, rows.length - processed),
      skipped,
      errors,
      originalBytes,
      compressedBytes,
      savingsPercent: originalBytes ? Number(((1 - compressedBytes / originalBytes) * 100).toFixed(2)) : 0,
      maxDimension,
      quality,
      updatedAt: new Date().toISOString(),
    }, null, 2), "utf8");
  };

  await writeStatus(false);
  for (const row of rows) {
    const payload = JSON.parse(row.payload);
    const recordId = payload.recordId ?? row.record_id;
    const imageFile = `images/${recordId}.webp`;
    const targetPath = join(workDir, imageFile);
    try {
      const existing = await stat(targetPath).catch(() => null);
      if (existing && payload.compressionStatus === "COMPRESSED" && row.compressed_bytes != null) {
        skipped += 1;
        originalBytes += row.original_bytes ?? 0;
        compressedBytes += row.compressed_bytes ?? existing.size;
      } else {
        const original = await readFile(row.source_path);
        const compressed = await compressionBuffer(original, { maxDimension, quality });
        const tempPath = `${targetPath}.part`;
        await writeFile(tempPath, compressed);
        await rename(tempPath, targetPath);
        updatePayload(db, row, payload, compressed.length, imageFile, { maxDimension, quality });
        originalBytes += original.length;
        compressedBytes += compressed.length;
      }
    } catch (error) {
      errors += 1;
      payload.compressionStatus = "ERROR";
      payload.compressionError = error instanceof Error ? error.message.slice(0, 240) : "erro desconhecido";
      db.prepare("update files set payload=?, updated_at=? where source_path=?").run(JSON.stringify(payload), new Date().toISOString(), row.source_path);
    }
    processed += 1;
    if (processed % 10 === 0) await writeStatus(false);
  }

  const manifestRows = db.prepare("select payload from files where payload is not null order by source_path").all().map((item) => JSON.parse(item.payload));
  await writeFile(manifestPath, JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), records: manifestRows }, null, 2), "utf8");
  await writeStatus(true);
  await writeFile(join(workDir, "COMPRESSAO_CONCLUIDA.txt"), `Compressão local concluída.\nRegistros: ${processed}/${rows.length}\nErros: ${errors}\n`, "utf8");
  db.close();
  console.log(JSON.stringify({ workDir, sourceFileCount: allRows.length, processed, skipped, errors, originalBytes, compressedBytes }));
}

run().catch((error) => {
  console.error(`Compressão interrompida: ${error instanceof Error ? error.message : "erro desconhecido"}`);
  process.exitCode = 1;
});

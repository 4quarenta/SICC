#!/usr/bin/env node

/** Apply locally reviewed ChatGPT/Codex corrections to the local checkpoint. */
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isValidCpf, normalizeCpf, parseBrazilianDate, normalizeName } from "./index.mjs";

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function likelyName(value) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  return text.split(" ").filter(Boolean).length >= 2 && normalizeName(text).length >= 5;
}

function classify(fields, currentState) {
  if (currentState === "MULTIPLE_PEOPLE") return "MULTIPLE_PEOPLE";
  if (!likelyName(fields.fullName)) return "INSUFFICIENT_DATA";
  if (!fields.cpf || !isValidCpf(fields.cpf)) return "INVALID_CPF";
  if (!fields.birthDate) return "REVIEW";
  return "READY_FOR_COMPRESSION";
}

async function run() {
  const args = process.argv.slice(2);
  const workDir = resolve(argValue(args, "--work", process.env.SICC_IMPORT_WORK_DIR ?? ""));
  const inputPath = resolve(argValue(args, "--input", ""));
  if (!workDir || !inputPath) throw new Error("Informe --work e --input.");
  const db = new DatabaseSync(join(workDir, "checkpoint.sqlite"));
  db.exec("PRAGMA busy_timeout = 30000;");
  const corrections = (await readFile(inputPath, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const find = db.prepare("select * from files where record_id = ?");
  const update = db.prepare("update files set state=?, reason=?, payload=?, updated_at=? where source_path=?");
  let applied = 0;
  let rejected = 0;
  for (const correction of corrections) {
    const row = find.get(correction.recordId);
    if (!row?.payload || typeof correction.imageText !== "string") { rejected += 1; continue; }
    const payload = JSON.parse(row.payload);
    const fields = correction.fields ?? correction.currentFields ?? {};
    const next = {
      ...payload,
      imageText: correction.imageText,
      fullName: likelyName(fields.fullName) ? String(fields.fullName).trim() : payload.fullName ?? null,
      cpf: isValidCpf(normalizeCpf(fields.cpf)) ? normalizeCpf(fields.cpf) : null,
      birthDate: parseBrazilianDate(fields.birthDate) ?? (/^\d{4}-\d{2}-\d{2}$/.test(String(fields.birthDate ?? "")) ? String(fields.birthDate) : null),
      motherName: likelyName(fields.motherName) ? String(fields.motherName).trim() : payload.motherName ?? null,
      nickname: fields.nickname ? String(fields.nickname).trim() : payload.nickname ?? null,
      city: fields.city ? String(fields.city).trim() : payload.city ?? null,
      state: /^[A-Za-z]{2}$/.test(String(fields.state ?? "")) ? String(fields.state).toUpperCase() : payload.state ?? null,
      tattooDescription: fields.tattooDescription ? String(fields.tattooDescription).trim() : payload.tattooDescription ?? null,
      ocrProvider: "chatgpt_review",
      ocrReviewStatus: "REVIEWED",
      ocrReviewedAt: new Date().toISOString(),
    };
    const state = classify(next, row.state);
    next.processingStatus = state;
    next.eligibleForCompression = state === "READY_FOR_COMPRESSION";
    next.missingRequiredFields = [!likelyName(next.fullName) ? "fullName" : null, !isValidCpf(next.cpf) ? "cpf" : null, !next.birthDate ? "birthDate" : null].filter(Boolean);
    update.run(state, correction.reason ?? "correção confirmada em revisão assistida", JSON.stringify(next), new Date().toISOString(), row.source_path);
    applied += 1;
  }
  const records = db.prepare("select payload from files where payload is not null order by source_path").all().map((row) => JSON.parse(row.payload));
  await writeFile(join(workDir, "manifest.json"), JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), records }, null, 2), "utf8");
  await writeFile(join(workDir, "review-apply-status.json"), JSON.stringify({ applied, rejected, total: corrections.length, updatedAt: new Date().toISOString() }, null, 2), "utf8");
  db.close();
  console.log(JSON.stringify({ applied, rejected, total: corrections.length }));
}

run().catch((error) => { console.error(`Revisão não aplicada: ${error instanceof Error ? error.message : "erro desconhecido"}`); process.exitCode = 1; });

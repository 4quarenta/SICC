#!/usr/bin/env node

/**
 * Local legacy-image importer for SICC.
 *
 * This module deliberately keeps OCR and image processing on the host. It uses
 * only the Supabase service endpoint for the final, authenticated destination.
 * No source image or OCR text is printed. The SQLite checkpoint and report are
 * local runtime artifacts and must never be committed.
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { createWorker } from "tesseract.js";
import { createClient } from "@supabase/supabase-js";
import { parseInfosegText } from "../../app/infoseg-parser.ts";

export const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".jfif", ".png", ".webp"]);
export const IMPORT_STATES = [
  "IMPORTED",
  "ATTACHED_TO_EXISTING",
  "DUPLICATE_IMAGE",
  "MULTIPLE_PEOPLE",
  "INVALID_CPF",
  "INSUFFICIENT_DATA",
  "REVIEW",
  "ERROR",
  "STAGED",
  "READY_FOR_COMPRESSION",
];

const DEFAULT_MAX_DIMENSION = 1600;
const DEFAULT_QUALITY = 78;
const DEFAULT_BUCKET = "sicc-media";
const DEFAULT_WORK_DIR = resolve(process.env.SICC_IMPORT_WORK_DIR ?? "./.work");

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function hasArg(args, name) { return args.includes(name); }

export function normalizeCpf(value) {
  return String(value ?? "").replace(/\D/g, "");
}

export function isValidCpf(value) {
  const cpf = normalizeCpf(value);
  if (cpf.length !== 11 || /^([0-9])\1{10}$/.test(cpf)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += Number(cpf[i]) * (10 - i);
  let digit = (sum * 10) % 11;
  if (digit === 10) digit = 0;
  if (digit !== Number(cpf[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i += 1) sum += Number(cpf[i]) * (11 - i);
  digit = (sum * 10) % 11;
  if (digit === 10) digit = 0;
  return digit === Number(cpf[10]);
}

export function parseBrazilianDate(value) {
  const match = String(value ?? "").match(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})\b/);
  if (!match) return null;
  const [, day, month, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function parseOcrBrazilianDate(value) {
  const candidates = String(value ?? "").toUpperCase().match(/[0-9OQDIL|ZSGTB]{1,2}[\/._\-][0-9OQDIL|ZSGTB]{1,2}[\/._\-][0-9OQDIL|ZSGTB]{4}/g) ?? [];
  for (const candidate of candidates) {
    const digits = [...candidate].map((character) => /\d/.test(character) ? character : OCR_DIGIT_SUBSTITUTIONS.get(character) ?? character).join("");
    const parsed = parseBrazilianDate(digits.replace(/[._\-]/g, "/"));
    if (parsed) return parsed;
  }
  return null;
}

export function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function cleanText(value) { return String(value ?? "").replace(/\s+/g, " ").trim(); }

export function extractCpfCandidates(text) {
  const source = String(text ?? "").toUpperCase();
  const candidates = new Set();
  const clusters = source.match(/(?:CPF\s*[:#-]?\s*)?[0-9A-Z|][0-9A-Z| ._\-–—]{7,28}[0-9A-Z|]/g) ?? [];
  for (const cluster of clusters) {
    candidates.add(cluster);
    const digits = cluster.replace(/\D/g, "");
    // OCR may join a nearby date or another numeric label to the CPF. Keep
    // only checksum-valid 11-digit windows instead of discarding the cluster.
    for (let index = 0; index <= digits.length - 11; index += 1) {
      const window = digits.slice(index, index + 11);
      if (isValidCpf(window)) candidates.add(window);
    }
    const repaired = repairCpfFromOcr(cluster);
    if (repaired) candidates.add(repaired);
  }
  return [...candidates];
}

const OCR_DIGIT_SUBSTITUTIONS = new Map([
  ["O", "0"], ["Q", "0"], ["D", "0"], ["I", "1"], ["L", "1"], ["|", "1"],
  ["Z", "2"], ["S", "5"], ["G", "6"], ["T", "7"], ["B", "8"],
]);

function cpfCheckDigits(firstNine) {
  if (!/^\d{9}$/.test(firstNine)) return null;
  let sum = 0;
  for (let index = 0; index < 9; index += 1) sum += Number(firstNine[index]) * (10 - index);
  let first = (sum * 10) % 11;
  if (first === 10) first = 0;
  sum = 0;
  const firstTen = `${firstNine}${first}`;
  for (let index = 0; index < 10; index += 1) sum += Number(firstTen[index]) * (11 - index);
  let second = (sum * 10) % 11;
  if (second === 10) second = 0;
  return `${first}${second}`;
}

function repairCpfFromOcr(raw) {
  const labelRemoved = String(raw ?? "").toUpperCase().replace(/^\s*CPF\s*[:#-]?\s*/, "");
  const glyphs = [...labelRemoved].filter((character) => /[0-9A-Z|]/.test(character));
  const digits = glyphs.map((character) => /\d/.test(character) ? character : OCR_DIGIT_SUBSTITUTIONS.get(character) ?? "").join("");
  // A correction is accepted only when the first nine document digits were
  // actually read as digits. We repair at most the two verifier digits, which
  // are deterministic; no identifying digit is guessed.
  if (digits.length !== 11 || !glyphs.slice(0, 9).every((character) => /\d/.test(character))) return null;
  if (glyphs.slice(9, 11).every((character) => /\d/.test(character))) return null;
  const check = cpfCheckDigits(digits.slice(0, 9));
  return check ? `${digits.slice(0, 9)}${check}` : null;
}


export function chooseValidCpf(texts) {
  const found = new Set();
  const validFromText = (text) => new Set(extractCpfCandidates(text).map(normalizeCpf).filter(isValidCpf));
  const readings = texts.map(validFromText);
  // The final reading is the locally enlarged caption region. When it yields
  // one checksum-valid CPF, it is stronger evidence than broad-page OCR that
  // may accidentally fuse dates or unrelated digits.
  const focused = readings.length >= 3 ? readings.at(-1) : null;
  if (focused?.size === 1) return [...focused][0];
  for (const reading of readings) {
    for (const cpf of reading) found.add(cpf);
  }
  return found.size === 1 ? [...found][0] : null;
}

function likelyPersonName(value) {
  const cleaned = cleanText(value).replace(/^[^:]{0,24}:\s*/, "");
  const normalized = normalizeName(cleaned);
  const words = cleaned.split(/\s+/).filter(Boolean);
  const letterWords = words.filter((word) => /\p{L}/u.test(word));
  return words.length >= 2
    && letterWords.length >= 2
    && words.every((word) => /^[\p{L}][\p{L}'’.-]*$/u.test(word.replace(/[,:;]+$/g, "")))
    && normalized.length >= 5
    && !/^(NOME|CPF|MAE|FILIACAO|DATA NASCIMENTO|SEXO)\b/.test(normalized);
}

export function parseFilename(filename) {
  const stem = basename(filename, extname(filename)).replace(/[_]+/g, " ").trim();
  const tattooMarker = /\b(?:TATUAG(?:EM|ENS)?|BRA[CÇ]O|ANTEBRA[CÇ]O|PEITO|T[ÓO]RAX|COSTAS|PESCO[CÇ]O|PERNA|PANTURRILHA|M[AÃ]O|DEDO|ROSTO|NUCA|OMBRO|BARRIGA|ABD[ÔO]MEN|DESENHO|TRIBAL)\b/i;
  const separated = stem.split(/\s+[-–—]\s+/).map(cleanText).filter(Boolean);
  const commaParts = separated.length === 1 ? stem.split(/\s*[,;]\s*/).map(cleanText).filter(Boolean) : [];
  // In this collection, a comma-only title commonly means NAME, TATTOO, TATTOO.
  // We only apply that interpretation when the first segment is name-like and
  // there is at least one suffix; otherwise the complete title remains intact.
  const parts = commaParts.length >= 2 && likelyPersonName(commaParts[0]) ? commaParts : separated;
  const firstPart = parts[0] ?? "";
  const inlineVulgo = firstPart.match(/\b(?:VULGO|ALCUNHA|APELIDO)\b\s*[:\-]?\s*(.+)$/i);
  const inlineTattooIndex = firstPart.search(tattooMarker);
  const firstBoundary = [inlineVulgo?.index, inlineTattooIndex >= 0 ? inlineTattooIndex : null]
    .filter((value) => Number.isInteger(value) && value >= 0)
    .sort((a, b) => a - b)[0];
  const fullName = cleanText(Number.isInteger(firstBoundary) ? firstPart.slice(0, firstBoundary) : firstPart);
  let nickname = null;
  const tattooParts = [];
  const ambiguousParts = [];
  if (inlineVulgo) {
    const tattooIndex = inlineVulgo[1].search(tattooMarker);
    nickname = cleanText(tattooIndex >= 0 ? inlineVulgo[1].slice(0, tattooIndex) : inlineVulgo[1]) || null;
    if (tattooIndex >= 0) tattooParts.push(cleanText(inlineVulgo[1].slice(tattooIndex).replace(/^TATUAG(?:EM|ENS)?\s*[:_-]?\s*/i, "")));
  } else if (inlineTattooIndex >= 0) {
    tattooParts.push(cleanText(firstPart.slice(inlineTattooIndex).replace(/^TATUAG(?:EM|ENS)?\s*[:_-]?\s*/i, "")));
  }
  for (const suffix of parts.slice(1)) {
    const explicitNickname = suffix.match(/\b(?:VULGO|ALCUNHA|APELIDO)\b\s*[:\-]?\s*(.+)$/i);
    if (explicitNickname) {
      const tattooIndex = explicitNickname[1].search(/\bTATUAG(?:EM|ENS)?\b/i);
      nickname ??= cleanText(tattooIndex >= 0 ? explicitNickname[1].slice(0, tattooIndex) : explicitNickname[1]);
      if (tattooIndex >= 0) tattooParts.push(cleanText(explicitNickname[1].slice(tattooIndex).replace(/^TATUAG(?:EM|ENS)?\s*[:_-]?\s*/i, "")));
      continue;
    }
    const explicitTattoo = tattooMarker.test(suffix);
    const cameFromCommaList = parts === commaParts;
    if (explicitTattoo || cameFromCommaList || /[,;]/.test(suffix)) tattooParts.push(suffix.replace(/^TATUAG(?:EM|ENS)?\s*[:_-]?\s*/i, ""));
    else ambiguousParts.push(suffix);
  }
  if (!nickname && ambiguousParts.length === 1 && ambiguousParts[0].split(/\s+/).length <= 2) nickname = ambiguousParts.shift();
  return {
    fullName: fullName || null,
    nickname,
    tattooDescription: tattooParts.length ? tattooParts.join(", ") : null,
    unclassifiedFilenameParts: ambiguousParts,
  };
}

export function detectMultiplePeople({ filename, ocrText = "" }) {
  const name = normalizeName(filename);
  const text = normalizeName(ocrText);
  if (/\b(?:FAMILIA|FAMILIARES|OUTRO|OUTRA|DUAS PESSOAS|TRES PESSOAS)\b/.test(name)) return true;
  if (/\b(?:NOME|NOME COMPLETO)\b/.test(text) && (text.match(/\bNOME\b/g) ?? []).length > 1) return true;
  const conjunctionMatch = name.match(/\b(?:E|AND|COM)\b/);
  if (conjunctionMatch) {
    const left = name.slice(0, conjunctionMatch.index);
    const right = name.slice((conjunctionMatch.index ?? 0) + conjunctionMatch[0].length);
    const leftWords = left.split(" ").filter((word) => word.length >= 2);
    const rightWords = right.split(" ").filter((word) => word.length >= 2 && !/^JPG$|^JPEG$|^PNG$|^WEBP$/.test(word));
    if (leftWords.length >= 2 && rightWords.length >= 2) return true;
  }
  const conjunction = /&/.test(filename);
  const candidateWords = name.split(" ").filter((word) => word.length >= 3 && !/^(VULGO|TATUAGEM|BRACO|ANTEBRACO|PEITO|COSTAS|PERNA|MAO|PESCOCO|CAVEIRA|CARPA|DRAGAO|JESUS|SANTA|TERCO)$/.test(word));
  return conjunction && candidateWords.length >= 5;
}

export function parseOcrFields(text) {
  const parsed = parseInfosegText(String(text ?? ""));
  const dynamic = inferFieldsFromOcrLines(String(text ?? ""));
  const comparableName = (value) => normalizeName(value).split(" ").filter((word) => word.length > 1).join(" ");
  const parsedMother = parsed.motherName && likelyPersonName(parsed.motherName) ? cleanText(parsed.motherName) : null;
  const dynamicMother = dynamic.motherName && likelyPersonName(dynamic.motherName) ? cleanText(dynamic.motherName) : null;
  const fullNameKey = comparableName(dynamic.fullName);
  return {
    fullName: dynamic.fullName ?? (parsed.fullName && likelyPersonName(parsed.fullName) ? cleanText(parsed.fullName) : null),
    motherName: [dynamicMother, parsedMother].find((value) => value && comparableName(value) !== fullNameKey) ?? null,
    nickname: dynamic.nickname ?? (parsed.nickname ? cleanText(parsed.nickname) : null),
    city: dynamic.city ?? (parsed.city ? cleanText(parsed.city) : null),
    state: dynamic.state,
    birthDate: (dynamic.birthDate ?? parsed.birthDate) || null,
    notes: parsed.notes || null,
  };
}

function inferFieldsFromOcrLines(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n").map(cleanText).filter(Boolean);
  const result = { fullName: null, motherName: null, nickname: null, city: null, state: null, birthDate: null };
  const names = [];
  for (const line of lines) {
    const stripped = line
      .replace(/^[^\p{L}\p{N}]*/u, "")
      // Tesseract commonly emits a one- or two-letter lowercase fragment
      // before the high-contrast uppercase caption (for example "dê NOME").
      // Remove only that shape; real names in this collection are uppercase.
      .replace(/^[a-zà-ÿ]{1,2}\s+(?=[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ]{2,}\b)/u, "")
      .trim();
    const mother = stripped.match(/^(?:M[AÃ]E|MAE|FILIA[CÇ][AÃ]O(?:\s*1)?)\s*[:\-]?\s*(.+)$/i);
    if (mother && likelyPersonName(mother[1])) {
      result.motherName ??= cleanText(mother[1]);
      continue;
    }
    const nickname = stripped.match(/^(?:VULGO|ALCUNHA|APELIDO)\s*[:\-]?\s*(.+)$/i);
    if (nickname?.[1]) {
      result.nickname ??= cleanText(nickname[1]);
      continue;
    }
    const named = stripped.match(/^(?:NOME(?:\s+COMPLETO)?)\s*[:\-]?\s*(.+)$/i);
    if (named && likelyPersonName(named[1])) {
      result.fullName ??= cleanText(named[1]);
      continue;
    }
    const date = parseBrazilianDate(stripped) ?? parseOcrBrazilianDate(stripped);
    if (date && /(?:NASC|DN\b|DATA\s*(?:DE\s*)?NASC)/i.test(stripped)) {
      result.birthDate ??= date;
      continue;
    }
    const cityLabel = stripped.match(/^(?:CIDADE|MUNIC[IÍ]PIO|LOCALIDADE)\s*[:\-]?\s*(.+)$/i);
    const cityState = (cityLabel?.[1] ?? stripped).match(/^(.+?)\s*(?:-|–|—)\s*([A-Z]{2})$/i);
    if (cityLabel?.[1]) {
      result.city ??= cleanText(cityState?.[1] ?? cityLabel[1]);
      result.state ??= cityState?.[2]?.toUpperCase() ?? null;
      continue;
    }
    if (cityState) {
      result.city ??= cleanText(cityState[1]);
      result.state ??= cityState[2].toUpperCase();
      continue;
    }
    if (likelyPersonName(stripped) && !/^(?:CPF|NASC|DATA\b|CIDADE|MUNICIPIO)\b/i.test(stripped)) names.push(stripped);
  }
  const uniqueNames = [...new Map(names.map((value) => [normalizeName(value), value])).values()];
  if (!result.fullName && uniqueNames.length) result.fullName = cleanText(uniqueNames[0]);
  if (!result.motherName && uniqueNames.length > 1) {
    const comparable = (value) => normalizeName(value).split(" ").filter((word) => word.length > 1).join(" ");
    const fullNameKey = comparable(result.fullName);
    result.motherName = cleanText(uniqueNames.find((value) => comparable(value) !== fullNameKey) ?? "") || null;
  }
  return result;
}

export function classifyRecord({ filename, ocrTexts, parsedFilename }) {
  const texts = Array.isArray(ocrTexts) ? ocrTexts : [String(ocrTexts ?? "")];
  const combined = texts.join("\n");
  const ocrFields = parseOcrFields(combined);
  const filenameName = parsedFilename.fullName && likelyPersonName(parsedFilename.fullName) ? parsedFilename.fullName : null;
  const filenameWords = filenameName?.split(/\s+/).filter(Boolean) ?? [];
  const ocrName = ocrFields.fullName && likelyPersonName(ocrFields.fullName) ? ocrFields.fullName : null;
  const preferOcrName = Boolean(ocrName && filenameName && /[,;]/.test(filename) && filenameWords.length > ocrName.split(/\s+/).length);
  const fields = {
    fullName: preferOcrName ? ocrName : filenameName ?? ocrName ?? null,
    nickname: parsedFilename.nickname ?? ocrFields.nickname ?? null,
    motherName: ocrFields.motherName ?? null,
    city: ocrFields.city ?? null,
    stateCode: ocrFields.state ?? null,
    birthDate: ocrFields.birthDate ?? null,
    tattooDescription: parsedFilename.tattooDescription ?? null,
    unclassifiedFilenameParts: parsedFilename.unclassifiedFilenameParts ?? [],
  };
  if (detectMultiplePeople({ filename, ocrText: combined })) return { ...fields, state: "MULTIPLE_PEOPLE", reason: "indicadores de mais de uma pessoa" };
  const cpf = chooseValidCpf(texts);
  if (!cpf) {
    const hasCpfToken = /\bCPF\b/i.test(combined) || extractCpfCandidates(combined).length > 0;
    return { ...fields, state: hasCpfToken ? "INVALID_CPF" : "INSUFFICIENT_DATA", reason: hasCpfToken ? "CPF não validado após as leituras locais" : "CPF confiável ausente", cpf: null };
  }
  if (!fields.fullName || !likelyPersonName(fields.fullName)) return { ...fields, state: "INSUFFICIENT_DATA", reason: "nome confiável ausente", cpf };
  if (!fields.birthDate) return { ...fields, state: "REVIEW", reason: "data de nascimento confiável ausente", cpf };
  return { ...fields, state: "READY", reason: "nome, CPF e nascimento validados", cpf };
}

export function compressImage(input, { maxDimension = DEFAULT_MAX_DIMENSION, quality = DEFAULT_QUALITY } = {}) {
  return sharp(input, { failOn: "error" }).rotate().resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true }).webp({ quality, effort: 6 }).toBuffer();
}

async function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function openCheckpoint(path) {
  const db = new DatabaseSync(path);
  // The progress monitor reads this database while the importer writes it.
  // Wait briefly for the writer instead of aborting the whole batch on a
  // transient SQLITE_BUSY/locked condition.
  db.exec("PRAGMA busy_timeout = 30000;");
  db.exec(`create table if not exists files (
    source_path text primary key,
    source_sha256 text not null,
    state text not null,
    person_id integer,
    media_id integer,
    reason text,
    original_bytes integer,
    compressed_bytes integer,
    record_id text,
    payload text,
    updated_at text not null
  );`);
  db.exec(`create table if not exists staged_records (
    source_path text primary key,
    source_sha256 text not null unique,
    stage_id text not null unique,
    payload text not null,
    created_at text not null
  );`);
  const fileColumns = db.prepare("pragma table_info(files)").all().map((column) => column.name);
  if (!fileColumns.includes("record_id")) db.exec("alter table files add column record_id text");
  if (!fileColumns.includes("payload")) db.exec("alter table files add column payload text");
  return db;
}

function checkpointRow(db, sourcePath, sha) {
  return db.prepare("select * from files where source_path = ? and source_sha256 = ?").get(sourcePath, sha);
}

function saveCheckpoint(db, row) {
  db.prepare(`insert into files(source_path,source_sha256,state,person_id,media_id,reason,original_bytes,compressed_bytes,record_id,payload,updated_at)
    values(?,?,?,?,?,?,?,?,?,?,?)
    on conflict(source_path) do update set source_sha256=excluded.source_sha256,state=excluded.state,person_id=excluded.person_id,media_id=excluded.media_id,reason=excluded.reason,original_bytes=excluded.original_bytes,compressed_bytes=excluded.compressed_bytes,record_id=excluded.record_id,payload=excluded.payload,updated_at=excluded.updated_at`).run(
    row.sourcePath, row.sourceSha256, row.state, row.personId ?? null, row.mediaId ?? null, row.reason ?? null, row.originalBytes ?? null, row.compressedBytes ?? null, row.recordId ?? null, row.payload ? JSON.stringify(row.payload) : null, new Date().toISOString(),
  );
}

function stagedBySha(db, sourceSha256) {
  return db.prepare("select stage_id, payload from staged_records where source_sha256 = ?").get(sourceSha256);
}

function saveStagedRecord(db, record) {
  db.prepare(`insert into staged_records(source_path,source_sha256,stage_id,payload,created_at)
    values(?,?,?,?,?)
    on conflict(source_path) do update set source_sha256=excluded.source_sha256,stage_id=excluded.stage_id,payload=excluded.payload,created_at=excluded.created_at`).run(
    record.sourcePath,
    record.sourceSha256,
    record.stageId,
    JSON.stringify(record.payload),
    new Date().toISOString(),
  );
}

async function writeStageManifest(db, manifestPath, runId) {
  const records = db.prepare("select payload from files where payload is not null order by source_path").all().map((row) => JSON.parse(row.payload));
  await writeFile(manifestPath, JSON.stringify({ version: 1, runId, generatedAt: new Date().toISOString(), records }, null, 2), "utf8");
  return records.length;
}

function stageSummary(db) {
  const records = db.prepare("select state, original_bytes, compressed_bytes, payload from files where payload is not null").all();
  const counts = Object.fromEntries(IMPORT_STATES.map((state) => [state, 0]));
  let preparedImages = 0;
  let eligibleForBatchImport = 0;
  let sourceOriginalBytes = 0;
  let compressedOriginalBytes = 0;
  let compressedBytes = 0;
  for (const row of records) {
    counts[row.state] = (counts[row.state] ?? 0) + 1;
    sourceOriginalBytes += row.original_bytes ?? 0;
    if (row.compressed_bytes != null) {
      preparedImages += 1;
      compressedOriginalBytes += row.original_bytes ?? 0;
      compressedBytes += row.compressed_bytes;
    }
    const payload = JSON.parse(row.payload);
    if (payload.eligibleForBatchImport || payload.eligibleForCompression) eligibleForBatchImport += 1;
  }
  return {
    recordsListed: records.length,
    counts,
    preparedImages,
    eligibleForBatchImport,
    sourceOriginalBytes,
    compressedOriginalBytes,
    compressedBytes,
    compressionSavingsPercent: compressedOriginalBytes ? Number(((1 - compressedBytes / compressedOriginalBytes) * 100).toFixed(2)) : 0,
  };
}

async function writeProgress(db, statusPath, sourceFileCount, completed = false) {
  const summary = stageSummary(db);
  await writeFile(statusPath, JSON.stringify({
    completed,
    sourceFileCount,
    processed: summary.recordsListed,
    remaining: Math.max(0, sourceFileCount - summary.recordsListed),
    counts: summary.counts,
    readyForNextStep: summary.eligibleForBatchImport,
    updatedAt: new Date().toISOString(),
  }, null, 2), "utf8");
}

async function listImages(sourceDir) {
  const paths = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && ALLOWED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        paths.push(path);
      }
    }
  }
  await visit(sourceDir);
  return paths.sort((a, b) => basename(a).localeCompare(basename(b), "pt-BR"));
}

async function ocrImage(worker, buffer, psm = "6") {
  await worker.setParameters({ tessedit_pageseg_mode: psm });
  const result = await worker.recognize(buffer);
  return result.data.text ?? "";
}

async function nativeOcr(tesseractPath, buffer, psm, tempDir) {
  const inputPath = join(tempDir, `ocr-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
  await writeFile(inputPath, buffer);
  try {
    return await new Promise((resolveText, reject) => {
      const child = spawn(tesseractPath, [inputPath, "stdout", "-l", "por", "--psm", psm], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolveText(stdout) : reject(new Error(`OCR local falhou (${code}): ${stderr.slice(0, 160)}`)));
    });
  } finally {
    await rm(inputPath, { force: true });
  }
}

function createPaddleOcrWorker(pythonPath) {
  const scriptPath = fileURLToPath(new URL("./paddle-ocr-worker.py", import.meta.url));
  const child = spawn(pythonPath, [scriptPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: "True", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
  });
  const pending = new Map();
  let sequence = 0;
  let disabled = false;
  let stderrTail = "";
  child.stderr.on("data", (chunk) => { stderrTail = `${stderrTail}${chunk}`.slice(-1200); });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const response = JSON.parse(line);
      const waiter = pending.get(response.id);
      if (!waiter) return;
      pending.delete(response.id);
      if (response.ok) waiter.resolve(response);
      else waiter.reject(new Error(response.error || "PaddleOCR local falhou."));
    } catch { /* mensagens não JSON do runtime local não contêm dados do lote */ }
  });
  child.on("exit", (code) => {
    for (const waiter of pending.values()) waiter.reject(new Error(`PaddleOCR local encerrou (${code ?? "sem código"}). ${stderrTail.slice(-400)}`));
    pending.clear();
  });
  const abort = () => {
    disabled = true;
    if (child.exitCode == null) child.kill();
  };
  return {
    get disabled() { return disabled; },
    recognize(buffer) {
      if (disabled) return Promise.reject(new Error("PaddleOCR local desativado após timeout."));
      const id = ++sequence;
      return new Promise((resolveResult, reject) => {
        pending.set(id, { resolve: resolveResult, reject });
        child.stdin.write(`${JSON.stringify({ id, imageBase64: buffer.toString("base64") })}\n`);
      });
    },
    abort,
    async close() {
      if (child.exitCode != null) return;
      child.stdin.end();
      await new Promise((resolveClose) => child.once("exit", resolveClose));
    },
  };
}

async function recognizePaddleSafely(paddleWorker, buffer) {
  if (!paddleWorker || paddleWorker.disabled) return "";
  let timer;
  try {
    const result = await Promise.race([
      paddleWorker.recognize(buffer),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("PaddleOCR local excedeu 120 segundos nesta imagem.");
          error.code = "PADDLE_TIMEOUT";
          reject(error);
        }, 120000);
      }),
    ]);
    return result?.text ?? "";
  } catch (error) {
    if (error?.code === "PADDLE_TIMEOUT") paddleWorker.abort();
    return "";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function localOcr({ worker, paddleWorker, tesseractPath, tempDir, quickExtraction = false }, buffers, noOcr, sourcePath = null) {
  if (noOcr) return [""];
  const [full, metadata] = Array.isArray(buffers) ? buffers : [buffers, null];
  // The complete image protects context such as name and city. A focused,
  // enlarged lower region captures captions commonly placed over the body.
  if (tesseractPath) {
    if (quickExtraction) return [await nativeOcr(tesseractPath, full, "6", tempDir)];
    const results = [await nativeOcr(tesseractPath, full, "6", tempDir), await nativeOcr(tesseractPath, full, "11", tempDir)];
    if (metadata) results.push(await nativeOcr(tesseractPath, metadata, "11", tempDir));
    const initialFields = parseOcrFields(results.join("\n"));
    const needsPaddle = !chooseValidCpf(results) || !initialFields.birthDate || !initialFields.motherName;
    if (paddleWorker && needsPaddle) results.push(await recognizePaddleSafely(paddleWorker, metadata ?? full));
    return results;
  }
  const results = [await ocrImage(worker, full, "6"), await ocrImage(worker, full, "11")];
  if (metadata) results.push(await ocrImage(worker, metadata, "11"));
  if (paddleWorker) results.push((await paddleWorker.recognize(full)).text ?? "");
  if (paddleWorker && metadata && !chooseValidCpf(results)) results.push((await paddleWorker.recognize(metadata)).text ?? "");
  return results;
}

async function prepareOcrBuffer(input) {
  return sharp(input, { failOn: "error" }).rotate().resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true }).png({ compressionLevel: 1 }).toBuffer();
}

export async function prepareOcrBuffers(input) {
  const normalized = await sharp(input, { failOn: "error" }).rotate().toBuffer();
  const metadata = await sharp(normalized).metadata();
  const full = await prepareOcrBuffer(normalized);
  if (!metadata.width || !metadata.height) return [full];
  const top = Math.floor(metadata.height * 0.48);
  const lower = await sharp(normalized)
    .extract({ left: 0, top, width: metadata.width, height: metadata.height - top })
    .resize({ height: 1800, withoutEnlargement: false })
    .grayscale()
    .normalize()
    .sharpen()
    .png({ compressionLevel: 1 })
    .toBuffer();
  return [full, lower];
}

function safeSummaryRow(row) {
  return { state: row.state, reason: row.reason ?? null, personId: row.personId ?? null, mediaId: row.mediaId ?? null, originalBytes: row.originalBytes ?? 0, compressedBytes: row.compressedBytes ?? 0 };
}

async function findAdmin(api) {
  const { data: profiles, error: profileError } = await api.from("operator_profiles").select("user_id,role").eq("role", "admin").order("created_at", { ascending: true }).limit(1);
  if (profileError || !profiles?.[0]) throw new Error("Nenhum administrador disponível para registrar a importação.");
  const { data: users, error: usersError } = await api.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (usersError) throw usersError;
  const user = users.users.find((item) => item.id === profiles[0].user_id);
  if (!user) throw new Error("Administrador não localizado no Auth.");
  return { id: user.id, email: user.email ?? "admin@sicc.local" };
}

async function fetchExisting(api) {
  const [{ data: people, error: peopleError }, { data: media, error: mediaError }] = await Promise.all([
    api.from("people").select("id,cpf,full_name,nickname,mother_name,birth_date,city,state,tattoo_description,notes"),
    api.from("person_media").select("id,person_id,sha256,object_key"),
  ]);
  if (peopleError || mediaError) throw peopleError ?? mediaError;
  return {
    peopleByCpf: new Map((people ?? []).map((row) => [normalizeCpf(row.cpf), row])),
    mediaBySha: new Map((media ?? []).map((row) => [String(row.sha256), row])),
  };
}

async function insertAudit(api, admin, runId, row) {
  const { error } = await api.from("audit_logs").insert({
    operator_id: admin.id,
    operator_email: admin.email,
    action: row.auditAction ?? "legacy_import",
    target_id: row.personId ?? null,
    query: `acervo_legado:${runId}`,
    changes: {
      import_run_id: runId,
      source_file: basename(row.sourcePath),
      source_sha256: row.sourceSha256,
      result: row.state,
      reason: row.reason ?? null,
      original_bytes: row.originalBytes ?? null,
      compressed_bytes: row.compressedBytes ?? null,
      captured_at_source: row.capturedAtSource ?? null,
      fields_updated: row.fieldsUpdated ?? [],
    },
  });
  if (error) throw error;
}

async function repairOptionalFields({ api, admin, existing, worker, sourcePath, previous, options, runId }) {
  const original = await readFile(sourcePath);
  const ocrTexts = await localOcr(options.ocr, await prepareOcrBuffers(original), options.noOcr);
  const parsedFilename = parseFilename(basename(sourcePath));
  const classification = classifyRecord({ filename: basename(sourcePath), ocrTexts, parsedFilename });
  if (classification.state !== "READY" || !previous.person_id) return previous;
  const person = existing.peopleByCpf.get(classification.cpf);
  if (!person || person.id !== previous.person_id) return previous;
  const optionalPatch = {};
  const optionalFields = [["nickname", classification.nickname], ["mother_name", classification.motherName], ["birth_date", classification.birthDate], ["city", classification.city], ["state", classification.stateCode], ["tattoo_description", classification.tattooDescription]];
  for (const [field, value] of optionalFields) {
    if ((person[field] == null || person[field] === "") && value) optionalPatch[field] = value;
  }
  if (!Object.keys(optionalPatch).length) return previous;
  const { error } = await api.from("people").update(optionalPatch).eq("id", person.id);
  if (error) throw error;
  Object.assign(person, optionalPatch);
  await insertAudit(api, admin, runId, { sourcePath, sourceSha256: previous.source_sha256, personId: person.id, state: previous.state, reason: "campos opcionais recuperados pelo parser da plataforma", fieldsUpdated: Object.keys(optionalPatch), auditAction: "legacy_import_correction" });
  return { state: previous.state, personId: previous.person_id, mediaId: previous.media_id, reason: "campos opcionais corrigidos", originalBytes: previous.original_bytes, compressedBytes: previous.compressed_bytes, sourcePath, sourceSha256: previous.source_sha256, skipped: true };
}

async function uploadAndRecord(api, admin, runId, row, buffer, existing) {
  const objectKey = `legacy-import/${runId}/${row.sourceSha256}.webp`;
  const upload = await api.storage.from(row.bucket).upload(objectKey, buffer, { contentType: "image/webp", upsert: false });
  if (upload.error) throw upload.error;
  const { data: media, error: mediaError } = await api.from("person_media").insert({
    person_id: row.personId,
    kind: "face",
    object_key: objectKey,
    original_name: basename(row.sourcePath),
    content_type: "image/webp",
    byte_size: buffer.length,
    sha256: row.sourceSha256,
    description: row.tattooDescription ?? null,
    captured_at: row.capturedAt ?? null,
  }).select("id").single();
  if (mediaError || !media) {
    await api.storage.from(row.bucket).remove([objectKey]);
    throw mediaError ?? new Error("Mídia não registrada.");
  }
  existing.mediaBySha.set(row.sourceSha256, { id: media.id, person_id: row.personId, sha256: row.sourceSha256, object_key: objectKey });
  row.mediaId = media.id;
  try {
    await insertAudit(api, admin, runId, row);
  } catch (error) {
    existing.mediaBySha.delete(row.sourceSha256);
    await api.from("person_media").delete().eq("id", media.id);
    await api.storage.from(row.bucket).remove([objectKey]);
    throw error;
  }
}

async function processOne({ api, admin, existing, worker, db, sourcePath, options, runId }) {
  const sourceSha256 = await sha256File(sourcePath);
  const sourceStat = await stat(sourcePath);
  const previous = checkpointRow(db, sourcePath, sourceSha256);
  if (previous && IMPORT_STATES.includes(previous.state) && options.repairFields && ["IMPORTED", "ATTACHED_TO_EXISTING"].includes(previous.state)) return repairOptionalFields({ api, admin, existing, worker, sourcePath, previous: { ...previous, source_sha256: sourceSha256 }, options, runId });
  if (previous && IMPORT_STATES.includes(previous.state)) return { state: previous.state, personId: previous.person_id, mediaId: previous.media_id, reason: "checkpoint existente", originalBytes: previous.original_bytes, compressedBytes: previous.compressed_bytes, sourcePath, sourceSha256, skipped: true };
  const original = await readFile(sourcePath);
  const parsedFilename = parseFilename(basename(sourcePath));
  const filenameHasMultiplePeople = detectMultiplePeople({ filename: basename(sourcePath) });
  const ocrTexts = filenameHasMultiplePeople ? [""] : await localOcr(options.ocr, await prepareOcrBuffers(original), options.noOcr);
  const classification = filenameHasMultiplePeople
    ? { state: "MULTIPLE_PEOPLE", reason: "indicadores de mais de uma pessoa no nome do arquivo" }
    : classifyRecord({ filename: basename(sourcePath), ocrTexts, parsedFilename });
  const base = { sourcePath, sourceSha256, originalBytes: sourceStat.size, bucket: options.bucket, capturedAt: sourceStat.mtime.toISOString(), capturedAtSource: "file_mtime_fallback", state: classification.state, reason: classification.reason, personId: null, mediaId: null, tattooDescription: classification.tattooDescription ?? null };
  if (classification.state !== "READY") {
    saveCheckpoint(db, base);
    await insertAudit(api, admin, runId, base);
    return base;
  }
  if (existing.mediaBySha.has(sourceSha256)) {
    base.state = "DUPLICATE_IMAGE";
    base.personId = existing.mediaBySha.get(sourceSha256).person_id;
    base.reason = "SHA-256 já registrado";
    saveCheckpoint(db, base);
    await insertAudit(api, admin, runId, base);
    return base;
  }
  const person = existing.peopleByCpf.get(classification.cpf);
  if (person) {
    base.personId = person.id;
    const optionalPatch = {};
    const optionalFields = [["nickname", classification.nickname], ["mother_name", classification.motherName], ["birth_date", classification.birthDate], ["city", classification.city], ["state", classification.stateCode], ["tattoo_description", classification.tattooDescription]];
    for (const [field, value] of optionalFields) {
      if ((person[field] == null || person[field] === "") && value) optionalPatch[field] = value;
    }
    if (Object.keys(optionalPatch).length) {
      const { error: optionalError } = await api.from("people").update(optionalPatch).eq("id", person.id);
      if (optionalError) throw optionalError;
      Object.assign(person, optionalPatch);
      base.fieldsUpdated = Object.keys(optionalPatch);
    }
    const compressed = await compressImage(original, options);
    base.compressedBytes = compressed.length;
    base.state = "ATTACHED_TO_EXISTING";
    base.reason = "CPF idêntico associado ao cadastro existente";
    await uploadAndRecord(api, admin, runId, base, compressed, existing);
    saveCheckpoint(db, base);
    return base;
  }
  const compressed = await compressImage(original, options);
  base.compressedBytes = compressed.length;
  if (compressed.length > 5 * 1024 * 1024) {
    base.state = "ERROR";
    base.reason = "imagem comprimida acima do limite do Storage";
    saveCheckpoint(db, base);
    await insertAudit(api, admin, runId, base);
    return base;
  }
  const { data: personRow, error: personError } = await api.from("people").insert({
    full_name: classification.fullName,
    nickname: classification.nickname ?? null,
    cpf: classification.cpf,
    birth_date: classification.birthDate ?? null,
    mother_name: classification.motherName ?? null,
    city: classification.city ?? null,
    state: classification.stateCode ?? null,
    status: "alive",
    custody_status: "free",
    notes: null,
    tattoo_description: classification.tattooDescription ?? null,
    created_by: admin.id,
  }).select("id").single();
  if (personError || !personRow) {
    const duplicate = String(personError?.message ?? "").toLowerCase().includes("duplicate") || String(personError?.code ?? "") === "23505";
    if (duplicate) {
      const refreshed = await fetchExisting(api);
      existing.peopleByCpf = refreshed.peopleByCpf;
      existing.mediaBySha = refreshed.mediaBySha;
      const samePerson = existing.peopleByCpf.get(classification.cpf);
      if (samePerson) {
        base.personId = samePerson.id;
        base.state = "ATTACHED_TO_EXISTING";
        base.reason = "CPF passou a existir durante o lote";
        await uploadAndRecord(api, admin, runId, base, compressed, existing);
        saveCheckpoint(db, base);
        return base;
      }
    }
    throw personError ?? new Error("Pessoa não criada.");
  }
  base.personId = personRow.id;
  existing.peopleByCpf.set(classification.cpf, { id: personRow.id, cpf: classification.cpf, full_name: classification.fullName });
  try {
    base.state = "IMPORTED";
    base.reason = "pessoa e mídia registradas";
    await uploadAndRecord(api, admin, runId, base, compressed, existing);
  } catch (error) {
    await api.from("people").delete().eq("id", personRow.id);
    throw error;
  }
  saveCheckpoint(db, base);
  return base;
}

async function stageOne({ worker, db, sourcePath, options }) {
  const sourceSha256 = await sha256File(sourcePath);
  const sourceStat = await stat(sourcePath);
  const previous = checkpointRow(db, sourcePath, sourceSha256);
  if (previous && IMPORT_STATES.includes(previous.state)) return { state: previous.state, personId: previous.person_id, mediaId: previous.media_id, reason: "checkpoint existente", originalBytes: previous.original_bytes, compressedBytes: previous.compressed_bytes, sourcePath, sourceSha256, skipped: true };
  const original = await readFile(sourcePath);
  const recordId = randomUUID();
  const parsedFilename = parseFilename(basename(sourcePath));
  const filenameHasMultiplePeople = detectMultiplePeople({ filename: basename(sourcePath) });
  const ocrTexts = filenameHasMultiplePeople ? [""] : await localOcr(options.ocr, await prepareOcrBuffers(original), options.noOcr);
  const classification = filenameHasMultiplePeople
    ? { state: "MULTIPLE_PEOPLE", reason: "indicadores de mais de uma pessoa no nome do arquivo" }
    : classifyRecord({ filename: basename(sourcePath), ocrTexts, parsedFilename });
  const base = { sourcePath, sourceSha256, originalBytes: sourceStat.size, capturedAt: sourceStat.mtime.toISOString(), capturedAtSource: "file_mtime_fallback", state: classification.state, reason: classification.reason, personId: null, mediaId: null, recordId, tattooDescription: classification.tattooDescription ?? null };
  const compressed = await compressImage(original, options);
  base.compressedBytes = compressed.length;
  if (compressed.length > 5 * 1024 * 1024) {
    base.state = "ERROR";
    base.reason = "imagem comprimida acima do limite do Storage";
    base.payload = buildStagePayload({ base, classification, imageFile: null });
    saveCheckpoint(db, base);
    return base;
  }
  const imageFile = `${recordId}.webp`;
  await writeFile(join(options.stageImagesDir, imageFile), compressed);
  if (classification.state === "READY") {
    base.state = "STAGED";
    base.reason = "imagem e dados preparados localmente para importação em lote";
  }
  base.payload = buildStagePayload({ base, classification, imageFile });
  saveCheckpoint(db, base);
  return { ...base };
}

async function extractDataOne({ db, sourcePath, options }) {
  const sourceSha256 = await sha256File(sourcePath);
  const sourceStat = await stat(sourcePath);
  const previous = checkpointRow(db, sourcePath, sourceSha256);
  if (previous?.payload && previous.state !== "ERROR" && IMPORT_STATES.includes(previous.state)) {
    return { state: previous.state, reason: "checkpoint existente", originalBytes: previous.original_bytes, sourcePath, sourceSha256, skipped: true };
  }
  const original = await readFile(sourcePath);
  const parsedFilename = parseFilename(basename(sourcePath));
  const ocrTexts = await localOcr(options.ocr, await prepareOcrBuffers(original), options.noOcr, sourcePath);
  const classification = classifyRecord({ filename: basename(sourcePath), ocrTexts, parsedFilename });
  const state = classification.state === "READY" ? "READY_FOR_COMPRESSION" : classification.state;
  const base = {
    sourcePath,
    sourceSha256,
    originalBytes: sourceStat.size,
    capturedAt: sourceStat.mtime.toISOString(),
    capturedAtSource: "file_mtime_fallback",
    state,
    reason: classification.reason,
    personId: null,
    mediaId: null,
    recordId: randomUUID(),
  };
  base.payload = buildExtractionPayload({ base, classification, options });
  saveCheckpoint(db, base);
  return base;
}

async function extractFullTextOne({ db, row, options }) {
  const sourcePath = row.source_path;
  const sourceSha256 = row.source_sha256;
  const previousPayload = row.payload ? JSON.parse(row.payload) : {};
  if (!options.forceFullText && previousPayload.ocrProvider === "local_tesseract_full" && typeof previousPayload.imageText === "string") {
    return { state: row.state, sourcePath, sourceSha256, skipped: true };
  }
  const original = await readFile(sourcePath);
  const sourceStat = await stat(sourcePath);
  const parsedFilename = parseFilename(basename(sourcePath));
  const ocrTexts = await localOcr(options.ocr, await prepareOcrBuffers(original), false, sourcePath);
  const classification = classifyRecord({ filename: basename(sourcePath), ocrTexts, parsedFilename });
  const state = classification.state === "READY" ? "READY_FOR_COMPRESSION" : classification.state;
  const base = {
    sourcePath,
    sourceSha256,
    originalBytes: sourceStat.size,
    capturedAt: sourceStat.mtime.toISOString(),
    capturedAtSource: row.payload ? (previousPayload.capturedAtSource ?? "file_mtime_fallback") : "file_mtime_fallback",
    state,
    reason: classification.reason,
    personId: row.person_id ?? null,
    mediaId: row.media_id ?? null,
    recordId: previousPayload.recordId ?? row.record_id ?? randomUUID(),
  };
  const payload = buildExtractionPayload({ base, classification, options, ocrTexts, previousPayload });
  // Preserve any copies produced before the phase-2 abort, but never use them
  // as an OCR source and never overwrite them in this mode.
  if (row.compressed_bytes != null) payload.compressedBytes = row.compressed_bytes;
  db.prepare("update files set state=?, reason=?, original_bytes=?, record_id=?, payload=?, updated_at=? where source_path=?").run(
    state,
    classification.reason ?? null,
    sourceStat.size,
    base.recordId,
    JSON.stringify(payload),
    new Date().toISOString(),
    sourcePath,
  );
  return { ...base, payload };
}

async function extractFullTextErrorRecord({ db, row, error }) {
  const payload = row.payload ? JSON.parse(row.payload) : {};
  payload.ocrProvider = "local_tesseract_full";
  payload.ocrReviewStatus = "ERROR";
  payload.ocrError = error instanceof Error ? error.message.slice(0, 240) : "erro desconhecido";
  db.prepare("update files set state='ERROR', reason=?, payload=?, updated_at=? where source_path=?").run(
    payload.ocrError,
    JSON.stringify(payload),
    new Date().toISOString(),
    row.source_path,
  );
  return { sourcePath: row.source_path, sourceSha256: row.source_sha256, state: "ERROR", reason: payload.ocrError };
}

async function writeFullTextProgress(db, statusPath, total, processed, completed = false) {
  const states = Object.fromEntries(IMPORT_STATES.map((state) => [state, 0]));
  for (const row of db.prepare("select state, count(*) as count from files group by state").all()) states[row.state] = Number(row.count);
  const textCount = Number(db.prepare("select count(*) as count from files where instr(payload, '\"imageText\":') > 0").get().count);
  await writeFile(statusPath, JSON.stringify({
    completed,
    sourceFileCount: total,
    processed,
    remaining: Math.max(0, total - processed),
    imageTextRecords: textCount,
    counts: states,
    updatedAt: new Date().toISOString(),
  }, null, 2), "utf8");
}

async function writeReviewQueue(db, path) {
  const rows = db.prepare("select state, reason, payload from files where payload is not null order by source_path").all();
  const reviewStates = new Set(["INVALID_CPF", "INSUFFICIENT_DATA", "REVIEW", "ERROR"]);
  const queue = [];
  for (const row of rows) {
    const payload = JSON.parse(row.payload);
    if (!reviewStates.has(row.state) && payload.ocrReviewStatus !== "REVIEW_REQUIRED") continue;
    queue.push({
      recordId: payload.recordId,
      originalName: payload.originalName,
      sourceImagePath: payload.sourceImagePath,
      imageText: payload.imageText ?? "",
      ocrReadings: payload.ocrReadings ?? [],
      currentFields: {
        fullName: payload.fullName ?? null,
        cpf: payload.cpf ?? null,
        birthDate: payload.birthDate ?? null,
        motherName: payload.motherName ?? null,
        nickname: payload.nickname ?? null,
        city: payload.city ?? null,
        state: payload.state ?? null,
        tattooDescription: payload.tattooDescription ?? null,
      },
      state: row.state,
      reason: row.reason ?? payload.reason ?? null,
    });
  }
  await writeFile(path, queue.map((item) => JSON.stringify(item)).join("\n") + (queue.length ? "\n" : ""), "utf8");
  return queue.length;
}

function bestImageText(ocrTexts) {
  const readings = (Array.isArray(ocrTexts) ? ocrTexts : [ocrTexts]).map((value) => String(value ?? ""));
  return readings.find((value) => value.trim()) ?? "";
}

function buildExtractionPayload({ base, classification, options, ocrTexts = null, previousPayload = null }) {
  const hasName = Boolean(classification.fullName && likelyPersonName(classification.fullName));
  const hasCpf = Boolean(classification.cpf && isValidCpf(classification.cpf));
  const hasBirthDate = Boolean(classification.birthDate && /^\d{4}-\d{2}-\d{2}$/.test(classification.birthDate));
  return {
    recordId: base.recordId,
    sourceImagePath: base.sourcePath,
    sourceRelativePath: relative(options.sourceRoot, base.sourcePath),
    originalName: basename(base.sourcePath),
    sourceSha256: base.sourceSha256,
    originalBytes: base.originalBytes,
    processingStatus: base.state,
    eligibleForCompression: hasName && hasCpf && hasBirthDate && base.state !== "MULTIPLE_PEOPLE",
    missingRequiredFields: [!hasName ? "fullName" : null, !hasCpf ? "cpf" : null, !hasBirthDate ? "birthDate" : null].filter(Boolean),
    reason: base.reason ?? null,
    fullName: classification.fullName ?? null,
    cpf: classification.cpf ?? null,
    birthDate: classification.birthDate ?? null,
    nickname: classification.nickname ?? null,
    motherName: classification.motherName ?? null,
    city: classification.city ?? null,
    state: classification.stateCode ?? null,
    tattooDescription: classification.tattooDescription ?? null,
    unclassifiedFilenameParts: classification.unclassifiedFilenameParts ?? [],
    capturedAt: base.capturedAt,
    capturedAtSource: base.capturedAtSource,
    imagePrepared: previousPayload?.imagePrepared ?? false,
    imageFile: previousPayload?.imageFile ?? null,
    ocrProcessing: options.fullTextExtraction ? "local_tesseract_full" : options.quickExtraction ? "local_tesseract_quick" : "local_paddleocr_and_tesseract",
    imageText: options.fullTextExtraction ? bestImageText(ocrTexts) : (previousPayload?.imageText ?? null),
    ocrReadings: options.fullTextExtraction ? (Array.isArray(ocrTexts) ? ocrTexts : []) : (previousPayload?.ocrReadings ?? []),
    ocrProvider: options.fullTextExtraction ? "local_tesseract_full" : (previousPayload?.ocrProvider ?? null),
    ocrCompletedAt: options.fullTextExtraction ? new Date().toISOString() : (previousPayload?.ocrCompletedAt ?? null),
    ocrReviewStatus: options.fullTextExtraction
      ? (base.state === "READY_FOR_COMPRESSION" ? "READY" : "REVIEW_REQUIRED")
      : (previousPayload?.ocrReviewStatus ?? null),
  };
}

function buildStagePayload({ base, classification, imageFile }) {
  return {
    recordId: base.recordId,
    imageFile: imageFile ? `images/${imageFile}` : null,
    importStatus: classification.state === "READY" ? "READY_FOR_BATCH_IMPORT" : classification.state,
    eligibleForBatchImport: classification.state === "READY",
    reason: base.reason,
    originalName: basename(base.sourcePath),
    sourceSha256: base.sourceSha256,
    originalBytes: base.originalBytes,
    compressedBytes: base.compressedBytes ?? null,
    savingsPercent: base.originalBytes && base.compressedBytes ? Number(((1 - base.compressedBytes / base.originalBytes) * 100).toFixed(2)) : null,
    capturedAt: base.capturedAt,
    capturedAtSource: base.capturedAtSource,
    fullName: classification.fullName ?? null,
    cpf: classification.cpf ?? null,
    nickname: classification.nickname ?? null,
    motherName: classification.motherName ?? null,
    birthDate: classification.birthDate ?? null,
    city: classification.city ?? null,
    state: classification.stateCode ?? null,
    tattooDescription: classification.tattooDescription ?? null,
  };
}

async function stageErrorRecord({ db, sourcePath, error }) {
  const sourceSha256 = await sha256File(sourcePath);
  const sourceStat = await stat(sourcePath);
  const recordId = randomUUID();
  const reason = error instanceof Error ? error.message.slice(0, 240) : "erro desconhecido";
  const base = {
    sourcePath,
    sourceSha256,
    originalBytes: sourceStat.size,
    capturedAt: sourceStat.mtime.toISOString(),
    capturedAtSource: "file_mtime_fallback",
    state: "ERROR",
    reason,
    recordId,
  };
  base.payload = buildStagePayload({ base, classification: { state: "ERROR", reason }, imageFile: null });
  saveCheckpoint(db, base);
  return base;
}

async function extractDataErrorRecord({ db, sourcePath, error, options }) {
  const sourceSha256 = await sha256File(sourcePath);
  const sourceStat = await stat(sourcePath);
  const reason = error instanceof Error ? error.message.slice(0, 240) : "erro desconhecido";
  const base = {
    sourcePath,
    sourceSha256,
    originalBytes: sourceStat.size,
    capturedAt: sourceStat.mtime.toISOString(),
    capturedAtSource: "file_mtime_fallback",
    state: "ERROR",
    reason,
    recordId: randomUUID(),
  };
  base.payload = buildExtractionPayload({ base, classification: { state: "ERROR", reason }, options });
  saveCheckpoint(db, base);
  return base;
}

async function run() {
  const args = process.argv.slice(2);
  const sourceArgument = argValue(args, "--source", process.env.SICC_IMPORT_SOURCE ?? "");
  const sourceDir = sourceArgument ? resolve(sourceArgument) : "";
  const workDir = resolve(argValue(args, "--work", process.env.SICC_IMPORT_WORK_DIR ?? DEFAULT_WORK_DIR));
  const projectUrl = argValue(args, "--url", process.env.SUPABASE_URL ?? "");
  const serviceKey = argValue(args, "--service-role-key", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const bucket = argValue(args, "--bucket", process.env.SICC_STORAGE_BUCKET ?? DEFAULT_BUCKET);
  const dryRun = hasArg(args, "--dry-run");
  const limit = Number(argValue(args, "--limit", "0")) || 0;
  const maxDimension = Number(argValue(args, "--max-dimension", String(DEFAULT_MAX_DIMENSION))) || DEFAULT_MAX_DIMENSION;
  const quality = Number(argValue(args, "--quality", String(DEFAULT_QUALITY))) || DEFAULT_QUALITY;
  const noOcr = hasArg(args, "--no-ocr");
  const repairFields = hasArg(args, "--repair-fields");
  const stageOnly = hasArg(args, "--stage-only");
  const extractDataOnly = hasArg(args, "--extract-data-only");
  const extractFullText = hasArg(args, "--extract-full-text");
  const forceFullText = hasArg(args, "--force-full-text");
  const quickExtraction = hasArg(args, "--quick-extract");
  const tesseractPath = argValue(args, "--tesseract", process.env.SICC_TESSERACT_PATH ?? "");
  const paddlePythonPath = argValue(args, "--paddle-python", process.env.SICC_PADDLE_PYTHON ?? "");
  const requestedOcrWorkers = Number(argValue(args, "--ocr-workers", "2")) || 2;
  const extractionConcurrency = extractDataOnly ? Math.max(1, Math.min(2, Math.trunc(requestedOcrWorkers))) : 1;
  if (!sourceDir && !extractFullText && !dryRun && !stageOnly && !extractDataOnly) throw new Error("Informe --source ou use --extract-full-text com um checkpoint existente.");
  if (!dryRun && !stageOnly && !extractDataOnly && !extractFullText && (!projectUrl || !serviceKey)) throw new Error("Informe --url e a variável SUPABASE_SERVICE_ROLE_KEY para importação real.");
  if (extractDataOnly && !tesseractPath) throw new Error("A extração de dados exige um Tesseract local.");
  if (extractFullText && !tesseractPath) throw new Error("A extração completa exige um Tesseract local.");
  if (extractDataOnly && !quickExtraction && !paddlePythonPath) throw new Error("A extração completa exige --paddle-python local.");
  const files = sourceDir ? (await listImages(sourceDir)).slice(0, limit || undefined) : [];
  await mkdir(workDir, { recursive: true });
  const checkpointPath = join(workDir, "checkpoint.sqlite");
  const reportPath = join(workDir, dryRun ? "dry-run-report.json" : extractFullText ? "full-text-report.json" : extractDataOnly ? "data-extraction-report.json" : stageOnly ? "stage-report.json" : "import-report.json");
  const stageImagesDir = join(workDir, "images");
  const stageManifestPath = join(workDir, "manifest.json");
  const statusPath = join(workDir, "status.json");
  const db = openCheckpoint(checkpointPath);
  // A later source directory is intentionally allowed to append to the same
  // local manifest/checkpoint. Count the union so the progress denominator
  // remains correct across multiple legacy volumes.
  const checkpointSourcePaths = new Set(db.prepare("select source_path from files").all().map((row) => row.source_path));
  const fullTextRows = extractFullText
    ? db.prepare("select * from files where payload is not null order by source_path").all().slice(0, limit || undefined)
    : [];
  const sourceFileCount = checkpointSourcePaths.size + files.filter((file) => !checkpointSourcePaths.has(file)).length;
  if (stageOnly) await mkdir(stageImagesDir, { recursive: true });
  const api = !stageOnly && !extractDataOnly && serviceKey && projectUrl ? createClient(projectUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } }) : null;
  const admin = api ? await findAdmin(api) : null;
  const existing = api ? await fetchExisting(api) : { peopleByCpf: new Map(), mediaBySha: new Map() };
  const ocrTempDir = join(workDir, "ocr-tmp");
  await mkdir(ocrTempDir, { recursive: true });
  const worker = noOcr || tesseractPath ? null : await createWorker("por");
  const paddleWorkers = extractDataOnly && !quickExtraction
    ? Array.from({ length: extractionConcurrency }, () => createPaddleOcrWorker(paddlePythonPath))
    : [];
  const runIdPath = join(workDir, "run-id.txt");
  let runId;
  try {
    runId = (await readFile(runIdPath, "utf8")).trim();
  } catch {
    runId = `legacy-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
    await writeFile(runIdPath, `${runId}\n`, "utf8");
  }
  const options = { bucket, maxDimension, quality, noOcr, repairFields, quickExtraction, fullTextExtraction: extractFullText, forceFullText, sourceRoot: sourceDir || dirname(dirname(fullTextRows[0]?.source_path ?? workDir)), stageImagesDir, ocr: { worker, paddleWorker: paddleWorkers[0] ?? null, tesseractPath, tempDir: ocrTempDir, quickExtraction: false } };
  if (extractFullText) {
    await rm(join(workDir, "FULL_TEXT_CONCLUIDO.txt"), { force: true });
    await writeFullTextProgress(db, join(workDir, "full-text-status.json"), fullTextRows.length, 0, false);
  } else if (extractDataOnly) {
    await rm(join(workDir, "CONCLUIDO.txt"), { force: true });
    await writeProgress(db, statusPath, sourceFileCount, false);
  }
  const rows = [];
  if (extractFullText) {
    let completedCount = 0;
    for (const row of fullTextRows) {
      try {
        rows.push(await extractFullTextOne({ db, row, options }));
      } catch (error) {
        rows.push(await extractFullTextErrorRecord({ db, row, error }));
      }
      completedCount += 1;
      if (completedCount % 10 === 0) {
        await writeFullTextProgress(db, join(workDir, "full-text-status.json"), fullTextRows.length, completedCount, false);
      }
    }
  } else if (extractDataOnly) {
    let completedCount = 0;
    let progressChain = Promise.resolve();
    const persistProgress = () => {
      progressChain = progressChain.then(async () => {
        await writeStageManifest(db, stageManifestPath, runId);
        await writeProgress(db, statusPath, sourceFileCount, false);
      });
      return progressChain;
    };
    await Promise.all(Array.from({ length: extractionConcurrency }, async (_, slot) => {
      const workerOptions = { ...options, ocr: { ...options.ocr, paddleWorker: paddleWorkers[slot] } };
      for (let index = slot; index < files.length; index += extractionConcurrency) {
        const sourcePath = files[index];
        try {
          rows[index] = await extractDataOne({ db, sourcePath, options: workerOptions });
        } catch (error) {
          rows[index] = await extractDataErrorRecord({ db, sourcePath, error, options: workerOptions });
        }
        completedCount += 1;
        if (completedCount % 10 === 0) await persistProgress();
      }
    }));
    await progressChain;
  } else for (const sourcePath of files) {
    if (dryRun) {
      const sourceSha256 = await sha256File(sourcePath);
      const original = await readFile(sourcePath);
      const parsedFilename = parseFilename(basename(sourcePath));
      const filenameHasMultiplePeople = detectMultiplePeople({ filename: basename(sourcePath) });
      const ocrTexts = filenameHasMultiplePeople ? [""] : await localOcr(options.ocr, await prepareOcrBuffers(original), noOcr);
      const classification = filenameHasMultiplePeople
        ? { state: "MULTIPLE_PEOPLE", reason: "indicadores de mais de uma pessoa no nome do arquivo" }
        : classifyRecord({ filename: basename(sourcePath), ocrTexts, parsedFilename });
      const compressed = classification.state === "READY" ? await compressImage(original, options) : null;
      rows.push({ sourcePath, sourceSha256, state: classification.state, reason: classification.reason, originalBytes: original.length, compressedBytes: compressed?.length ?? 0 });
      continue;
    }
    if (stageOnly) {
      try {
        rows.push(await stageOne({ worker, db, sourcePath, options }));
      } catch (error) {
        rows.push(await stageErrorRecord({ db, sourcePath, error }));
      }
      if (rows.length % 25 === 0) await writeStageManifest(db, stageManifestPath, runId);
      continue;
    }
    try {
      rows.push(await processOne({ api, admin, existing, worker, db, sourcePath, options, runId }));
    } catch (error) {
      const sourceSha256 = await sha256File(sourcePath);
      const row = { sourcePath, sourceSha256, state: "ERROR", reason: error instanceof Error ? error.message.slice(0, 240) : "erro desconhecido" };
      saveCheckpoint(db, row);
      try { await insertAudit(api, admin, runId, row); } catch { /* preserve original error and local checkpoint */ }
      rows.push(row);
    }
  }
  if (worker) await worker.terminate();
  for (const paddleWorker of paddleWorkers) await paddleWorker.close();
  const localManifestMode = stageOnly || extractDataOnly || extractFullText;
  const stagedRecords = localManifestMode ? await writeStageManifest(db, stageManifestPath, runId) : 0;
  const stagedSummary = localManifestMode ? stageSummary(db) : null;
  const reportStates = dryRun ? [...IMPORT_STATES, "READY"] : IMPORT_STATES;
  const counts = Object.fromEntries(reportStates.map((state) => [state, rows.filter((row) => row.state === state).length]));
  const originalBytes = rows.reduce((sum, row) => sum + (row.originalBytes ?? 0), 0);
  const compressedBytes = rows.reduce((sum, row) => sum + (row.compressedBytes ?? 0), 0);
  const report = { generatedAt: new Date().toISOString(), runId, dryRun, stageOnly, extractDataOnly, extractFullText, quickExtraction, sourceFileCount: extractFullText ? fullTextRows.length : extractDataOnly ? sourceFileCount : files.length, counts: stagedSummary?.counts ?? counts, originalBytes: stagedSummary?.sourceOriginalBytes ?? originalBytes, compressedBytes: stagedSummary?.compressedBytes ?? compressedBytes, savingsPercent: stagedSummary?.compressionSavingsPercent ?? (originalBytes ? Number(((1 - compressedBytes / originalBytes) * 100).toFixed(2)) : 0), stagedRecords, recordsListed: stagedSummary?.recordsListed ?? 0, preparedImages: stagedSummary?.preparedImages ?? 0, eligibleForBatchImport: stagedSummary?.eligibleForBatchImport ?? 0, compressedOriginalBytes: stagedSummary?.compressedOriginalBytes ?? 0, manifestPath: localManifestMode ? stageManifestPath : null, rows: rows.map(safeSummaryRow) };
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  if (extractFullText) {
    const reviewQueuePath = join(workDir, "review-queue.jsonl");
    const reviewQueueCount = await writeReviewQueue(db, reviewQueuePath);
    await writeFullTextProgress(db, join(workDir, "full-text-status.json"), fullTextRows.length, fullTextRows.length, true);
    await writeFile(join(workDir, "FULL_TEXT_CONCLUIDO.txt"), `Extração completa concluída.\nRegistros: ${fullTextRows.length}/${fullTextRows.length}\nFila de revisão: ${reviewQueueCount}\n`, "utf8");
  } else if (extractDataOnly) {
    await writeProgress(db, statusPath, sourceFileCount, true);
    await writeFile(join(workDir, "CONCLUIDO.txt"), `Extração local concluída.\nRegistros: ${stagedSummary?.recordsListed ?? 0}/${sourceFileCount}\nProntos para compressão: ${stagedSummary?.eligibleForBatchImport ?? 0}\n`, "utf8");
  }
  db.close();
  console.log(JSON.stringify({ reportPath, sourceFileCount: extractFullText ? fullTextRows.length : files.length, counts, originalBytes, compressedBytes, savingsPercent: report.savingsPercent }));
}

export async function validateArchive({ tool, archive }) {
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(tool, ["t", archive], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolveResult({ code, output }));
  });
  if (result.code !== 0 || !/Everything is Ok/i.test(result.output)) throw new Error("Validação do arquivo multipartes falhou.");
  const volumes = Number(result.output.match(/Volumes\s*=\s*(\d+)/i)?.[1] ?? 0);
  const files = Number(result.output.match(/Files:\s*(\d+)/i)?.[1] ?? 0);
  return { volumes, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) run().catch((error) => { console.error(`Importador interrompido: ${error instanceof Error ? error.message : "erro desconhecido"}`); process.exitCode = 1; });

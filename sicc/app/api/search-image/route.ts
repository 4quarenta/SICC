import { requireSession } from "../../auth";

export const dynamic = "force-dynamic";

function database() {
  const binding = (globalThis as typeof globalThis & { __SICC_DB?: D1Database }).__SICC_DB;
  if (!binding) throw new Error("Banco de dados indisponível.");
  return binding;
}

async function ensureVisualHashColumn(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS person_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      object_key TEXT NOT NULL UNIQUE,
      original_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      description TEXT,
      face_embedding TEXT,
      captured_at TEXT,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operator_email TEXT NOT NULL,
      action TEXT NOT NULL,
      target_id INTEGER,
      query TEXT,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS person_media_hash_idx ON person_media(sha256)"),
  ]);
  const columns = await db.prepare("PRAGMA table_info(person_media)").all<{ name: string }>();
  if (!(columns.results ?? []).some((column) => column.name === "visual_hash")) {
    await db.prepare("ALTER TABLE person_media ADD COLUMN visual_hash TEXT").run();
  }
  const refreshedColumns = await db.prepare("PRAGMA table_info(person_media)").all<{ name: string }>();
  if (!(refreshedColumns.results ?? []).some((column) => column.name === "face_embedding")) {
    await db.prepare("ALTER TABLE person_media ADD COLUMN face_embedding TEXT").run();
  }
}

async function fileHash(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hammingDistance(left: string, right: string) {
  if (!left || !right || left.length !== right.length) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const value = parseInt(left[index], 16) ^ parseInt(right[index], 16);
    distance += value.toString(2).replaceAll("0", "").length;
  }
  return distance;
}

type VisualSignature = {
  version: "legacy" | "v2";
  legacy: string;
  fitAverage?: string;
  fitDifference?: string;
  cropAverage?: string;
  cropDifference?: string;
};

function parseVisualSignature(value: string): VisualSignature | null {
  const normalized = value.trim().toLowerCase();
  if (/^[0-9a-f]{16}$/.test(normalized)) return { version: "legacy", legacy: normalized };
  const parts = normalized.split("|");
  if (parts.length !== 6 || parts[0] !== "v2") return null;
  const [legacy, fitAverage, fitDifference, cropAverage, cropDifference] = parts.slice(1);
  if (!/^[0-9a-f]{16}$/.test(legacy)) return null;
  if (!/^[0-9a-f]{64}$/.test(fitAverage) || !/^[0-9a-f]{60}$/.test(fitDifference)) return null;
  if (!/^[0-9a-f]{64}$/.test(cropAverage) || !/^[0-9a-f]{60}$/.test(cropDifference)) return null;
  return { version: "v2", legacy, fitAverage, fitDifference, cropAverage, cropDifference };
}

function normalizedDistance(left: string, right: string) {
  const distance = hammingDistance(left, right);
  return Number.isFinite(distance) ? distance / (left.length * 4) : Number.POSITIVE_INFINITY;
}

function visualDistance(query: VisualSignature, candidate: VisualSignature) {
  if (query.version === "legacy" || candidate.version === "legacy") {
    return normalizedDistance(query.legacy, candidate.legacy);
  }
  return (
    normalizedDistance(query.legacy, candidate.legacy) * 0.15
    + normalizedDistance(query.fitAverage!, candidate.fitAverage!) * 0.25
    + normalizedDistance(query.fitDifference!, candidate.fitDifference!) * 0.15
    + normalizedDistance(query.cropAverage!, candidate.cropAverage!) * 0.30
    + normalizedDistance(query.cropDifference!, candidate.cropDifference!) * 0.15
  );
}

function parseEmbedding(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length === 128 && parsed.every((item) => typeof item === "number" && Number.isFinite(item)) ? parsed as number[] : null;
  } catch {
    return null;
  }
}

function embeddingDistance(left: number[], right: number[]) {
  if (left.length !== right.length) return Number.POSITIVE_INFINITY;
  return Math.sqrt(left.reduce((sum, value, index) => sum + ((value - right[index]) ** 2), 0));
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Acesso não autenticado." }, { status: 401 });
  const operator = session.email;
  const form = await request.formData();
  const image = form.get("image");
  const mode = form.get("mode") === "tattoo" ? "tattoo" : "face";
  if (!(image instanceof File) || !image.size) {
    return Response.json({ error: "Selecione uma imagem para consulta." }, { status: 400 });
  }
  if (!["image/jpeg", "image/png", "image/webp"].includes(image.type) || image.size > 5 * 1024 * 1024) {
    return Response.json({ error: "Use uma imagem JPG, PNG ou WEBP de até 5 MB." }, { status: 400 });
  }
  const sha256 = await fileHash(image);
  const visualHash = typeof form.get("visualHash") === "string" ? String(form.get("visualHash")) : "";
  const querySignature = parseVisualSignature(visualHash);
  const queryEmbedding = parseEmbedding(form.get("faceEmbedding"));
  const db = database();
  await ensureVisualHashColumn(db);
  const kindClause = mode === "tattoo" ? "kind = 'tattoo'" : "kind IN ('face', 'face_front', 'face_profile')";
  const candidates = mode === "face" && queryEmbedding
    ? await db.prepare(`SELECT person_id AS personId, face_embedding AS faceEmbedding, sha256 FROM person_media WHERE ${kindClause} AND ((face_embedding IS NOT NULL AND length(trim(face_embedding)) > 0) OR sha256 = ?)`).bind(sha256).all<{ personId: number; faceEmbedding: string | null; sha256: string }>()
    : mode === "tattoo" && querySignature
      ? await db.prepare(`SELECT person_id AS personId, visual_hash AS visualHash, sha256 FROM person_media WHERE ${kindClause} AND ((visual_hash IS NOT NULL AND length(trim(visual_hash)) > 0) OR sha256 = ?)`).bind(sha256).all<{ personId: number; visualHash: string | null; sha256: string }>()
      : await db.prepare(`SELECT DISTINCT person_id AS personId, visual_hash AS visualHash, face_embedding AS faceEmbedding, sha256 FROM person_media WHERE sha256 = ? AND ${kindClause} LIMIT 10`).bind(sha256).all<{ personId: number; visualHash: string | null; faceEmbedding: string | null; sha256: string }>();
  const ranked = (candidates.results ?? []).map((candidate) => ({
    personId: candidate.personId,
    distance: candidate.sha256 === sha256
      ? 0
      : mode === "face" && queryEmbedding && "faceEmbedding" in candidate && candidate.faceEmbedding
        ? (() => {
          try {
            const parsed = JSON.parse(candidate.faceEmbedding);
            return Array.isArray(parsed) && parsed.length === 128 ? embeddingDistance(queryEmbedding, parsed as number[]) : Number.POSITIVE_INFINITY;
          } catch {
            return Number.POSITIVE_INFINITY;
          }
        })()
        : mode === "tattoo" && querySignature && "visualHash" in candidate && candidate.visualHash
          ? visualDistance(querySignature, parseVisualSignature(candidate.visualHash) ?? { version: "legacy", legacy: "" })
          : Number.POSITIVE_INFINITY,
  })).filter((candidate) => candidate.distance <= (mode === "face" ? 0.6 : 0.36)).sort((left, right) => left.distance - right.distance);
  const unique = new Map<number, number>();
  for (const candidate of ranked) if (!unique.has(candidate.personId)) unique.set(candidate.personId, candidate.distance);
  await db.prepare("INSERT INTO audit_logs (operator_email, action, query, created_at) VALUES (?, ?, ?, ?)")
    .bind(operator, mode === "tattoo" ? "SEARCH_TATTOO_SIMILARITY" : "SEARCH_FACE_SIMILARITY", `${mode === "face" && queryEmbedding ? "embedding" : "visual"}:${(visualHash || (queryEmbedding ? "face" : `sha256:${sha256.slice(0, 12)}`)).slice(0, 16)}`, new Date().toISOString()).run();
  return Response.json({
    personIds: [...unique.keys()].slice(0, 10),
    matchType: mode === "face" && queryEmbedding ? "face_embedding" : querySignature ? "visual_similarity" : "exact_file",
    notice: unique.size
      ? mode === "face"
        ? "Candidatos ordenados por similaridade facial. Confirme manualmente o rosto e os dados antes de qualquer providência."
        : "Candidatos ordenados por similaridade visual aproximada. Confirme manualmente a imagem e os dados antes de qualquer providência."
      : "Nenhum candidato visualmente semelhante foi localizado. A consulta é apenas apoio e não confirma identidade.",
  });
}

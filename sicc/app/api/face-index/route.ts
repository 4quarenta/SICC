import { requireSession } from "../../auth";

export const dynamic = "force-dynamic";

type EmbeddingUpdate = { mediaId?: unknown; embedding?: unknown };

function database() {
  const binding = (globalThis as typeof globalThis & { __SICC_DB?: D1Database }).__SICC_DB;
  if (!binding) throw new Error("Banco de dados indisponível.");
  return binding;
}

async function ensureFaceEmbeddingColumn() {
  const db = database();
  const columns = await db.prepare("PRAGMA table_info(person_media)").all<{ name: string }>();
  if (!(columns.results ?? []).some((column) => column.name === "face_embedding")) {
    await db.prepare("ALTER TABLE person_media ADD COLUMN face_embedding TEXT").run();
  }
}

function validEmbedding(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length === 128
    && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

export async function GET() {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Acesso não autenticado." }, { status: 401 });
  await ensureFaceEmbeddingColumn();
  const rows = await database().prepare(`
    SELECT id, original_name AS originalName
    FROM person_media
    WHERE kind IN ('face', 'face_front', 'face_profile')
      AND (face_embedding IS NULL OR length(trim(face_embedding)) = 0)
    ORDER BY id ASC
    LIMIT 100
  `).all<{ id: number; originalName: string }>();
  return Response.json({
    media: (rows.results ?? []).map((row) => ({ id: row.id, originalName: row.originalName, url: `/api/media/${row.id}` })),
  });
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Acesso não autenticado." }, { status: 401 });
  await ensureFaceEmbeddingColumn();
  const body = await request.json().catch(() => null) as { updates?: EmbeddingUpdate[] } | null;
  const updates = Array.isArray(body?.updates) ? body.updates.slice(0, 100) : [];
  const validUpdates = updates
    .map((update) => ({ mediaId: Number(update.mediaId), embedding: update.embedding }))
    .filter((update): update is { mediaId: number; embedding: number[] } => Number.isInteger(update.mediaId) && update.mediaId > 0 && validEmbedding(update.embedding));
  if (!validUpdates.length) return Response.json({ updated: 0 });

  const db = database();
  const statements = validUpdates.map((update) => db.prepare(`
    UPDATE person_media
    SET face_embedding = ?
    WHERE id = ? AND kind IN ('face', 'face_front', 'face_profile')
  `).bind(JSON.stringify(update.embedding), update.mediaId));
  await db.batch(statements);
  await db.prepare("INSERT INTO audit_logs (operator_email, action, query, created_at) VALUES (?, 'REINDEX_FACE_EMBEDDINGS', ?, ?)")
    .bind(session.email, `count:${validUpdates.length}`, new Date().toISOString()).run();
  return Response.json({ updated: validUpdates.length });
}

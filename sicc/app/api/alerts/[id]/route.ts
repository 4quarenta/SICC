import { database, requireSession } from "../../../auth";

export const dynamic = "force-dynamic";

function bucket() {
  const binding = (globalThis as typeof globalThis & { __SICC_BUCKET?: R2Bucket }).__SICC_BUCKET;
  if (!binding) throw new Error("Armazenamento de imagens indisponível.");
  return binding;
}

async function ensureSchema() {
  const db = database();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS qtc_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, category_key TEXT NOT NULL, category_label TEXT NOT NULL, priority TEXT NOT NULL, municipality TEXT NOT NULL, municipality_state TEXT, neighborhood TEXT, people_info TEXT, vehicle_info TEXT, description TEXT NOT NULL, occurred_at TEXT, location_link TEXT, latitude TEXT, longitude TEXT, accuracy_meters INTEGER, status TEXT NOT NULL DEFAULT 'open', created_by TEXT NOT NULL, created_by_name TEXT NOT NULL, created_at TEXT NOT NULL, resolved_by TEXT, resolved_by_name TEXT, resolved_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS qtc_alert_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id INTEGER NOT NULL,
      object_key TEXT NOT NULL UNIQUE,
      original_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      sha256 TEXT NOT NULL,
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
  ]);
  const columns = await db.prepare("PRAGMA table_info(qtc_alerts)").all<{ name: string }>();
  if (!columns.results.some((column) => column.name === "municipality_state")) {
    await db.prepare("ALTER TABLE qtc_alerts ADD COLUMN municipality_state TEXT").run();
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const operator = await requireSession();
  if (!operator) return Response.json({ error: "Acesso não autenticado." }, { status: 401 });
  await ensureSchema();
  const id = Number((await context.params).id);
  if (!Number.isInteger(id) || id < 1) return Response.json({ error: "QTC inválido." }, { status: 400 });
  let body: { status?: string } = {};
  try { body = await request.json() as { status?: string }; } catch { /* corpo vazio */ }
  if (body.status !== "resolved" && body.status !== "open") return Response.json({ error: "Status inválido." }, { status: 400 });
  const now = new Date().toISOString();
  const result = body.status === "resolved"
    ? await database().prepare("UPDATE qtc_alerts SET status = 'resolved', resolved_by = ?, resolved_by_name = ?, resolved_at = ? WHERE id = ?").bind(operator.email, operator.name || operator.email, now, id).run()
    : await database().prepare("UPDATE qtc_alerts SET status = 'open', resolved_by = NULL, resolved_by_name = NULL, resolved_at = NULL WHERE id = ?").bind(id).run();
  if (!result.meta.changes) return Response.json({ error: "QTC não encontrado." }, { status: 404 });
  await database().prepare("INSERT INTO audit_logs (operator_email, action, target_id, query, created_at) VALUES (?, ?, ?, ?, ?)").bind(operator.email, body.status === "resolved" ? "RESOLVE_ALERT" : "REOPEN_ALERT", id, body.status, now).run().catch(() => undefined);
  return Response.json({ updated: true });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const operator = await requireSession();
  if (!operator) return Response.json({ error: "Acesso não autenticado." }, { status: 401 });
  await ensureSchema();
  const id = Number((await context.params).id);
  if (!Number.isInteger(id) || id < 1) return Response.json({ error: "QTC inválido." }, { status: 400 });
  const db = database();
  const alert = await db.prepare("SELECT id, created_by FROM qtc_alerts WHERE id = ?").bind(id).first<{ id: number; created_by: string }>();
  if (!alert) return Response.json({ error: "QTC não encontrado." }, { status: 404 });
  if (operator.role !== "admin" && alert.created_by !== operator.email) {
    return Response.json({ error: "Somente o autor ou o administrador pode apagar este QTC." }, { status: 403 });
  }
  const media = await db.prepare("SELECT object_key FROM qtc_alert_media WHERE alert_id = ?").bind(id).all<{ object_key: string }>();
  for (const item of media.results ?? []) await bucket().delete(item.object_key);
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("DELETE FROM qtc_alert_media WHERE alert_id = ?").bind(id),
    db.prepare("DELETE FROM qtc_alerts WHERE id = ?").bind(id),
    db.prepare("INSERT INTO audit_logs (operator_email, action, target_id, query, created_at) VALUES (?, ?, ?, ?, ?)").bind(operator.email, "DELETE_ALERT", id, "QTC apagado", now),
  ]);
  return Response.json({ deleted: true });
}

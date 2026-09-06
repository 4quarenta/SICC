import { database, requireSession } from "../../../auth";

export async function GET(request: Request) {
  if (!await requireSession("admin")) return Response.json({ error: "Acesso restrito ao administrador." }, { status: 403 });
  const url = new URL(request.url); const page = Math.max(1, Number(url.searchParams.get("page")) || 1); const limit = 10;
  const db = database();
  const count = await db.prepare("SELECT COUNT(*) AS total FROM operators").first<{ total: number }>();
  const rows = await db.prepare(`SELECT o.id, COALESCE(NULLIF(o.war_name, ''), o.name_rank) AS name,
    COALESCE(NULLIF(o.war_name, ''), o.name_rank) AS warName, COALESCE(NULLIF(o.rank, ''), '') AS rank,
    o.email, o.role, o.created_at AS createdAt,
    inviter.name_rank AS invitedBy FROM operators o LEFT JOIN operators inviter ON inviter.id = o.invited_by
    ORDER BY o.id DESC LIMIT ? OFFSET ?`).bind(limit, (page - 1) * limit).all();
  return Response.json({ rows: rows.results, total: Number(count?.total ?? 0), page, limit });
}

export async function DELETE(request: Request) {
  const admin = await requireSession("admin");
  if (!admin) return Response.json({ error: "Acesso restrito ao administrador." }, { status: 403 });
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!id || id === admin.id) return Response.json({ error: "A conta administradora atual não pode ser apagada." }, { status: 400 });
  const db = database();
  await db.batch([
    db.prepare("DELETE FROM operator_sessions WHERE operator_id = ?").bind(id),
    db.prepare("DELETE FROM operator_invites WHERE created_by = ?").bind(id),
    db.prepare("DELETE FROM operators WHERE id = ? AND role != 'admin'").bind(id),
  ]);
  return Response.json({ deleted: true });
}

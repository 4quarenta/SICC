import { database, requireSession } from "../../../auth";

export async function GET(request: Request) {
  if (!await requireSession("admin")) return Response.json({ error: "Acesso restrito ao administrador." }, { status: 403 });
  const url = new URL(request.url); const page = Math.max(1, Number(url.searchParams.get("page")) || 1); const limit = 10;
  const db = database();
  const count = await db.prepare("SELECT COUNT(*) AS total FROM people").first<{ total: number }>();
  const rows = await db.prepare(`SELECT id, full_name AS name, cpf, created_by AS createdBy, created_at AS createdAt
    FROM people ORDER BY id DESC LIMIT ? OFFSET ?`).bind(limit, (page - 1) * limit).all();
  return Response.json({ rows: rows.results, total: Number(count?.total ?? 0), page, limit });
}

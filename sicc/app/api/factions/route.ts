import { requireSession } from "../../auth";

export const dynamic = "force-dynamic";

function database() {
  const binding = (globalThis as typeof globalThis & { __SICC_DB?: D1Database }).__SICC_DB;
  if (!binding) throw new Error("Banco de dados indisponível.");
  return binding;
}

export async function GET() {
  if (!await requireSession()) return Response.json({ error: "Acesso não autenticado." }, { status: 401 });
  const db = database();
  await db.prepare("CREATE TABLE IF NOT EXISTS factions (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)").run();
  const result = await db.prepare("SELECT id, name FROM factions ORDER BY name COLLATE NOCASE").all<{ id: number; name: string }>();
  return Response.json({ factions: result.results });
}

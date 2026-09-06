import { requireSession } from "../../../../auth";

export const dynamic = "force-dynamic";

function database() {
  const binding = (globalThis as typeof globalThis & { __SICC_DB?: D1Database }).__SICC_DB;
  if (!binding) throw new Error("Banco de dados indisponível.");
  return binding;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Acesso não autenticado." }, { status: 401 });
  const operator = session.email;
  const { id } = await context.params;
  const personId = Number(id);
  const body = await request.json() as Record<string, unknown>;
  const latitude = String(body.latitude ?? "").trim();
  const longitude = String(body.longitude ?? "").trim();
  if (!personId || !latitude || !longitude) {
    return Response.json({ error: "A localização atual é obrigatória para registrar uma abordagem." }, { status: 400 });
  }
  const now = new Date().toISOString();
  const db = database();
  const person = await db.prepare("SELECT id FROM people WHERE id = ?").bind(personId).first();
  if (!person) return Response.json({ error: "Cadastro não encontrado." }, { status: 404 });
  const result = await db.prepare(`INSERT INTO approaches
    (person_id, occurred_at, latitude, longitude, accuracy_meters, location_label, notes, operator_email, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      personId,
      String(body.occurredAt || now),
      latitude,
      longitude,
      Number(body.accuracyMeters) || null,
      String(body.locationLabel || "").trim() || null,
      String(body.notes || "").trim() || null,
      operator,
      now,
    ).run();
  await db.prepare("INSERT INTO audit_logs (operator_email, action, target_id, created_at) VALUES (?, 'CREATE_APPROACH', ?, ?)")
    .bind(operator, personId, now).run();
  return Response.json({ id: Number(result.meta.last_row_id) }, { status: 201 });
}

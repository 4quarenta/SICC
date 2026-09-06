import { database, hashPassword, randomToken, sessionCookie, sha256 } from "../../../auth";

export async function POST(request: Request) {
  const body = await request.json() as { invite?: string; warName?: string; rank?: string; email?: string; password?: string };
  const inviteCode = String(body.invite ?? "").trim().toUpperCase();
  const warName = String(body.warName ?? "").trim().toUpperCase();
  const rank = String(body.rank ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (inviteCode.length < 8 || warName.length < 2 || !rank || !email.includes("@") || password.length < 8) return Response.json({ error: "Revise o convite, nome de guerra, posto/graduação, e-mail e senha de no mínimo 8 caracteres." }, { status: 400 });
  const db = database();
  const invite = await db.prepare(`SELECT id, created_by FROM operator_invites
    WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? LIMIT 1`).bind(await sha256(inviteCode), new Date().toISOString()).first<{ id: number; created_by: number }>();
  if (!invite) return Response.json({ error: "Convite inválido, utilizado ou expirado." }, { status: 400 });
  if (await db.prepare("SELECT id FROM operators WHERE lower(email) = ?").bind(email).first()) return Response.json({ error: "Este e-mail já está cadastrado." }, { status: 409 });
  const credentials = await hashPassword(password);
  const now = new Date().toISOString();
  const created = await db.prepare(`INSERT INTO operators (name_rank, email, password_hash, password_salt, role, invited_by, created_at)
    VALUES (?, ?, ?, ?, 'operator', ?, ?)`).bind(`${rank} ${warName}`, email, credentials.hash, credentials.salt, invite.created_by, now).run();
  const operatorId = Number(created.meta.last_row_id);
  await db.prepare("UPDATE operators SET war_name = ?, rank = ? WHERE id = ?").bind(warName, rank, operatorId).run();
  const consumed = await db.prepare("UPDATE operator_invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL")
    .bind(now, operatorId, invite.id).run();
  if (!consumed.meta.changes) {
    await db.prepare("DELETE FROM operators WHERE id = ?").bind(operatorId).run();
    return Response.json({ error: "Este convite já foi utilizado." }, { status: 409 });
  }
  const token = randomToken();
  await db.prepare("INSERT INTO operator_sessions (token_hash, operator_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), operatorId, new Date(Date.now() + 12 * 3600000).toISOString(), now).run();
  return Response.json({ ok: true }, { headers: { "set-cookie": sessionCookie(token) } });
}

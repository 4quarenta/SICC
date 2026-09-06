import { database, hashPassword, randomToken, sessionCookie, sha256 } from "../../../auth";

export async function POST(request: Request) {
  const body = await request.json() as { email?: string; password?: string };
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const db = database();
  const row = await db.prepare("SELECT id, password_hash, password_salt, failed_login_count, locked_until FROM operators WHERE lower(email) = ? LIMIT 1")
    .bind(email).first<{ id: number; password_hash: string; password_salt: string; failed_login_count: number; locked_until: string | null }>();
  if (row?.locked_until && row.locked_until > new Date().toISOString()) return Response.json({ error: "Conta temporariamente bloqueada. Tente novamente mais tarde." }, { status: 429 });
  const candidate = row ? await hashPassword(password, row.password_salt) : null;
  if (!row || candidate?.hash !== row.password_hash) {
    if (row) {
      const failures = row.failed_login_count + 1;
      await db.prepare("UPDATE operators SET failed_login_count = ?, locked_until = ? WHERE id = ?")
        .bind(failures >= 5 ? 0 : failures, failures >= 5 ? new Date(Date.now() + 15 * 60000).toISOString() : null, row.id).run();
    }
    return Response.json({ error: "E-mail ou senha inválidos." }, { status: 401 });
  }
  const token = randomToken();
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE operators SET failed_login_count = 0, locked_until = NULL WHERE id = ?").bind(row.id),
    db.prepare("INSERT INTO operator_sessions (token_hash, operator_id, expires_at, created_at) VALUES (?, ?, ?, ?)").bind(await sha256(token), row.id, new Date(Date.now() + 12 * 3600000).toISOString(), now),
  ]);
  return Response.json({ ok: true }, { headers: { "set-cookie": sessionCookie(token) } });
}

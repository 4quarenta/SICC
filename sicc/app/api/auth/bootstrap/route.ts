import { bootstrapSecret, configuredAdminEmail, database, hashPassword, platformEmail, randomToken, sessionCookie, sha256 } from "../../../auth";

export async function POST(request: Request) {
  const body = await request.json() as { warName?: string; rank?: string; email?: string; password?: string; bootstrapKey?: string };
  const configuredEmail = configuredAdminEmail();
  const ownerEmail = await platformEmail();
  const platformOwner = Boolean(ownerEmail && (!configuredEmail || ownerEmail === configuredEmail));
  const configuredBootstrapSecret = bootstrapSecret();
  if (!platformOwner && (!configuredBootstrapSecret || String(body.bootstrapKey ?? "") !== configuredBootstrapSecret)) return Response.json({ error: "Código de ativação inválido." }, { status: 403 });
  const warName = String(body.warName ?? "").trim().toUpperCase();
  const rank = String(body.rank ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (warName.length < 2 || !rank || !email || password.length < 8) return Response.json({ error: "Informe nome de guerra, posto/graduação, e-mail e uma senha com pelo menos 8 caracteres." }, { status: 400 });
  if (configuredEmail && email !== configuredEmail) return Response.json({ error: "Use o e-mail administrativo configurado para ativar o administrador." }, { status: 400 });
  if (!configuredEmail && platformOwner && ownerEmail && email !== ownerEmail) return Response.json({ error: "Use o e-mail da conta proprietária para ativar o administrador." }, { status: 400 });
  const db = database();
  const count = await db.prepare("SELECT COUNT(*) AS count FROM operators").first<{ count: number }>();
  if (Number(count?.count ?? 0) !== 0) return Response.json({ error: "A conta administradora já foi ativada." }, { status: 409 });
  const credentials = await hashPassword(password);
  const now = new Date().toISOString();
  const result = await db.prepare(`INSERT INTO operators (name_rank, email, password_hash, password_salt, role, created_at)
    VALUES (?, ?, ?, ?, 'admin', ?)`).bind(`${rank} ${warName}`, email, credentials.hash, credentials.salt, now).run();
  await db.prepare("UPDATE operators SET war_name = ?, rank = ? WHERE id = ?").bind(warName, rank, Number(result.meta.last_row_id)).run();
  const token = randomToken();
  await db.prepare("INSERT INTO operator_sessions (token_hash, operator_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), Number(result.meta.last_row_id), new Date(Date.now() + 12 * 3600000).toISOString(), now).run();
  return Response.json({ ok: true }, { headers: { "set-cookie": sessionCookie(token) } });
}

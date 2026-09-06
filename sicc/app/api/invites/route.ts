import { database, randomToken, requireSession, sha256 } from "../../auth";

export async function POST() {
  const operator = await requireSession();
  if (!operator) return Response.json({ error: "Acesso não autenticado." }, { status: 401 });
  const code = randomToken(9).toUpperCase();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 3600000).toISOString();
  await database().prepare("INSERT INTO operator_invites (code_hash, created_by, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(code), operator.id, expiresAt, now.toISOString()).run();
  return Response.json({ code, expiresAt });
}

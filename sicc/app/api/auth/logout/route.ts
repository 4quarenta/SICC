import { clearSessionCookie, database, sha256 } from "../../../auth";
import { cookies } from "next/headers";

export async function POST() {
  const token = (await cookies()).get("sicc_session")?.value;
  if (token) await database().prepare("DELETE FROM operator_sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  return Response.json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } });
}

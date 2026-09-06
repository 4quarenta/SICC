import { cookies, headers } from "next/headers";

export type SessionOperator = { id: number; name: string; warName: string; rank: string; email: string; role: "admin" | "operator"; invitedBy: string | null };
const SESSION_COOKIE = "sicc_session";

function env(name: string) {
  return (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name]?.trim() ?? "";
}

/** Optional bootstrap owner configured outside the repository. */
export function configuredAdminEmail() {
  return env("SICC_ADMIN_EMAIL").toLowerCase() || null;
}

export function bootstrapSecret() {
  return env("SICC_BOOTSTRAP_KEY");
}

/** R2 writes are an explicit opt-in so an unconfigured deploy cannot accrue storage charges. */
export function storageWritesEnabled() {
  return env("SICC_STORAGE_WRITE_ENABLED").toLowerCase() === "true";
}

export function database() {
  const binding = (globalThis as typeof globalThis & { __SICC_DB?: D1Database }).__SICC_DB;
  if (!binding) throw new Error("Banco de dados indisponível.");
  return binding;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function randomToken(bytes = 32) {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashPassword(password: string, suppliedSalt?: string) {
  const salt = suppliedSalt ? base64ToBytes(suppliedSalt) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  // Cloudflare Workers currently supports PBKDF2 iteration counts up to 100000.
  // Keep the highest supported value so password creation and login work in production.
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  return { hash: bytesToBase64(new Uint8Array(bits)), salt: bytesToBase64(salt) };
}

export async function getSession(): Promise<SessionOperator | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const row = await database().prepare(`SELECT o.id, COALESCE(NULLIF(o.war_name, ''), o.name_rank) AS name,
    COALESCE(NULLIF(o.war_name, ''), o.name_rank) AS warName, COALESCE(NULLIF(o.rank, ''), '') AS rank, o.email, o.role,
    CASE WHEN inviter.id IS NULL THEN NULL ELSE COALESCE(NULLIF(inviter.war_name, ''), inviter.name_rank) END AS invitedBy
    FROM operator_sessions s JOIN operators o ON o.id = s.operator_id
    LEFT JOIN operators inviter ON inviter.id = o.invited_by
    WHERE s.token_hash = ? AND s.expires_at > ? LIMIT 1`)
    .bind(await sha256(token), new Date().toISOString()).first<SessionOperator>();
  return row ?? null;
}

export async function requireSession(role?: "admin") {
  const operator = await getSession();
  if (!operator || (role && operator.role !== role)) return null;
  return operator;
}

export async function platformEmail() {
  return (await headers()).get("oai-authenticated-user-email")?.trim().toLowerCase() ?? null;
}

export function sessionCookie(token: string, maxAge = 60 * 60 * 12) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

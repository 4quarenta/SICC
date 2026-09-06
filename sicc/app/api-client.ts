import { requireSupabase } from "./supabase-browser";

const configuredApi = ((import.meta.env.VITE_SICC_API_URL as string | undefined)?.trim() || "https://wsfvpmypmezljeltarhz.supabase.co/functions/v1/sicc-api").replace(/\/$/, "");

/**
 * Keep the existing /api contract while the browser is hosted by GitHub Pages.
 * The bearer token is read from the Supabase session for every request so a
 * refresh or token rotation never leaves the API with a stale credential.
 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit) {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const target = raw.startsWith("/api") && configuredApi
    ? `${configuredApi}${raw.slice(4)}`
    : raw;
  const headers = new Headers(init?.headers);
  const client = requireSupabase();
  const publishableKey = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined)?.trim() || "sb_publishable_OME7kzPLD68iEvjru56_MA_pFdj44k-";
  headers.set("apikey", publishableKey);
  const { data } = await client.auth.getSession();
  if (data.session?.access_token) headers.set("Authorization", `Bearer ${data.session.access_token}`);
  return fetch(target, { ...init, headers });
}

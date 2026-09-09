import { requireSupabase } from "./supabase-browser";

const configuredApi = ((import.meta.env.VITE_SICC_API_URL as string | undefined)?.trim() || "https://wsfvpmypmezljeltarhz.supabase.co/functions/v1/sicc-api").replace(/\/$/, "");
const peopleSearchApi = "https://wsfvpmypmezljeltarhz.supabase.co/functions/v1/sicc-people-search";

/**
 * Keep the existing /api contract while the browser is hosted by GitHub Pages.
 * The bearer token is read from the Supabase session for every request so a
 * refresh or token rotation never leaves the API with a stale credential.
 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit) {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const isPeopleTextSearch = raw.startsWith("/api/people?") && new URL(raw, window.location.origin).searchParams.has("q");
  const target = isPeopleTextSearch
    ? `${peopleSearchApi}?${new URL(raw, window.location.origin).searchParams.toString()}`
    : raw.startsWith("/api") && configuredApi
      ? `${configuredApi}${raw.slice(4)}`
      : raw;
  const headers = new Headers(init?.headers);
  const client = requireSupabase();
  // The hosted Edge Functions accept the project legacy anon key at the gateway.
  // Authorization is still enforced inside the functions with the current Supabase session.
  const publicKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim()
    || (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined)?.trim()
    || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndzZnZwbXlwbWV6bGplbHRhcmh6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5MzE2MTksImV4cCI6MjEwMDUwNzYxOX0.fSnSYNoWk6_Ay2d-hOApMyHndFkeqihNo_Q2CsGSGZU";
  headers.set("apikey", publicKey);
  const { data } = await client.auth.getSession();
  if (data.session?.access_token) headers.set("Authorization", `Bearer ${data.session.access_token}`);
  return fetch(target, { ...init, headers });
}

import { createClient } from "@supabase/supabase-js";

const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() || "https://wsfvpmypmezljeltarhz.supabase.co";
const publicKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim()
  || (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined)?.trim()
  || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndzZnZwbXlwbWV6bGplbHRhcmh6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5MzE2MTksImV4cCI6MjEwMDUwNzYxOX0.fSnSYNoWk6_Ay2d-hOApMyHndFkeqihNo_Q2CsGSGZU";

export const supabase = url && publicKey
  ? createClient(url, publicKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

export function requireSupabase() {
  if (!supabase) {
    throw new Error("Supabase não está configurado. Defina VITE_SUPABASE_URL e VITE_SUPABASE_PUBLISHABLE_KEY.");
  }
  return supabase;
}

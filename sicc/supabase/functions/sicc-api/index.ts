import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const bucket = Deno.env.get("SICC_STORAGE_BUCKET") ?? "sicc-media";
// The App ID is public and also embedded in the frontend. Keep an explicit
// fallback so push delivery does not silently stop when only the secret was
// configured in Supabase.
const oneSignalAppId = (Deno.env.get("ONESIGNAL_APP_ID") ?? "6934d3ea-0e2f-4273-8196-6415d4933815").trim();
const oneSignalRestApiKey = (Deno.env.get("ONESIGNAL_REST_API_KEY") ?? "").trim();
const webAppUrl = Deno.env.get("SICC_WEB_APP_URL") ?? "https://4quarenta.github.io/SICC/";
const api = createClient(supabaseUrl, serviceRoleKey);

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("SICC_ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Cache-Control": "no-store",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function fail(message: string, status = 400) { return json({ error: message }, status); }

type PushDispatchStatus = "sent" | "not_configured" | "failed" | "no_subscribers";

async function notifyNewQtc(category: string, priority: string, createdBy?: string): Promise<PushDispatchStatus> {
  // A QTC must still be saved if the optional notification provider is
  // unavailable. The REST key never reaches the browser.
  if (!oneSignalAppId || !oneSignalRestApiKey) return "not_configured";
  const { data: profiles, error: profilesError } = await api
    .from("operator_profiles")
    .select("user_id")
    .neq("user_id", createdBy ?? "00000000-0000-0000-0000-000000000000");
  if (profilesError) {
    console.error("OneSignal QTC recipients unavailable", profilesError.message);
    return "failed";
  }
  const externalIds = (profiles ?? [])
    .map((profile) => String(profile.user_id ?? "").trim())
    .filter(Boolean);
  if (externalIds.length === 0) return "no_subscribers";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch("https://api.onesignal.com/notifications", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Key ${oneSignalRestApiKey}`,
      },
      body: JSON.stringify({
        app_id: oneSignalAppId,
        name: `SICC QTC · ${category}`,
        target_channel: "push",
        include_aliases: { external_id: externalIds },
        headings: { "pt-BR": "Novo QTC operacional", en: "Novo QTC operacional" },
        contents: { "pt-BR": `${category} · Prioridade ${priority}`, en: `${category} · Prioridade ${priority}` },
        url: webAppUrl,
        data: { type: "qtc", category, priority },
      }),
    });
    const responseBody = await response.text();
    if (!response.ok) {
      console.error("OneSignal QTC notification failed", response.status, responseBody.slice(0, 500));
      return "failed";
    }
    try {
      const result = JSON.parse(responseBody) as { recipients?: number };
      if (typeof result.recipients === "number" && result.recipients === 0) return "no_subscribers";
    } catch {
      // A successful response without JSON is still treated as accepted.
    }
    return "sent";
  } catch (error) {
    console.error("OneSignal QTC notification unavailable", error instanceof Error ? error.message : "unknown");
    return "failed";
  } finally {
    clearTimeout(timeout);
  }
}

function clean(value: FormDataEntryValue | string | null | undefined) {
  return typeof value === "string" ? value.trim() : "";
}

async function resolveFactionId(form: FormData): Promise<{ id: number | null; error?: string }> {
  if (clean(form.get("factionAffiliated")) !== "yes") return { id: null };
  const choice = clean(form.get("factionId"));
  const newName = clean(form.get("newFactionName"));
  // Safari/iOS pode perder o valor controlado do select no FormData.
  // Se houver nome de nova facção e a opção não for um ID numérico,
  // trate explicitamente como criação de nova facção.
  if (choice === "new" || (newName.length > 0 && !/^\d+$/.test(choice))) {
    if (!newName) return { id: null, error: "Informe o nome da nova facção." };
    const { data: existing, error: existingError } = await api.from("factions").select("id").ilike("name", newName).maybeSingle();
    if (existingError) return { id: null, error: existingError.message };
    if (existing) return { id: existing.id as number };
    const { data, error } = await api.from("factions").insert({ name: newName }).select("id").single();
    if (error || !data) return { id: null, error: error?.message ?? "Não foi possível criar a facção." };
    return { id: data.id as number };
  }
  const id = Number(choice);
  if (!Number.isInteger(id) || id <= 0) return { id: null, error: "Selecione uma facção existente ou escolha adicionar uma nova." };
  const { data, error } = await api.from("factions").select("id").eq("id", id).maybeSingle();
  if (error || !data) return { id: null, error: error?.message ?? "A facção selecionada não existe." };
  return { id };
}

async function bodyJson(req: Request) {
  try { return await req.json() as Record<string, unknown>; } catch { return {}; }
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Bytes(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const alertCategories: Record<string, { label: string; priority: "Baixa" | "Média" | "Alta" | "Extrema" }> = {
  "ataque-instituicao-valores": { label: "Ataque a Instituição Financeira / Valores", priority: "Extrema" },
  "risco-a-tropa": { label: "Risco à Tropa", priority: "Extrema" },
  "cerco-bloqueio": { label: "Cerco e Bloqueio", priority: "Alta" },
  "desaparecimento-vulneravel": { label: "Desaparecimento de Vulnerável", priority: "Alta" },
  "descumprimento-medida-protetiva": { label: "Descumprimento de Medida Protetiva", priority: "Alta" },
  "suspeito-em-fuga": { label: "Suspeito em Fuga", priority: "Alta" },
  "roubo-carga-alto-valor": { label: "Roubo de Carga / Bem de Alto Valor", priority: "Média" },
  "roubo-furto": { label: "Roubo / Furto", priority: "Média" },
  "roubo-furto-veiculo": { label: "Roubo/Furto de Veículo", priority: "Média" },
  "subtracao-arma-fogo": { label: "Subtração de Arma de Fogo", priority: "Média" },
  "outros": { label: "Outros", priority: "Média" },
  "pessoa-desaparecida": { label: "Pessoa Desaparecida", priority: "Média" },
  "foragido-mandado": { label: "Foragido / Mandado em Aberto", priority: "Baixa" },
  "informacao-apuracao": { label: "Informação em Apuração", priority: "Baixa" },
  "atitude-suspeita": { label: "Atitude Suspeita", priority: "Média" },
};

function alertPayload(row: Record<string, unknown>, images: Array<Record<string, unknown>> = []) {
  const priority = String(row.priority ?? "Média").toLowerCase().replace("média", "media") as "baixa" | "media" | "alta" | "extrema";
  return {
    id: row.id,
    categoryKey: row.category_key,
    categoryLabel: row.category_label,
    priority,
    municipality: row.municipality,
    municipalityState: row.municipality_state,
    neighborhood: row.neighborhood,
    peopleInfo: row.people_info,
    vehicleInfo: row.vehicle_info,
    description: row.description,
    occurredAt: row.occurred_at,
    locationLink: row.location_link,
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
    accuracyMeters: row.accuracy_meters ?? null,
    status: row.status,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    resolvedBy: row.resolved_by ?? null,
    resolvedByName: row.resolved_by_name ?? null,
    resolvedAt: row.resolved_at ?? null,
    images,
  };
}

async function alertRows(rows: Array<Record<string, unknown>>) {
  const ids = rows.map((row) => row.id as number);
  if (!ids.length) return [];
  const { data, error } = await api.from("qtc_alert_media").select("*").in("alert_id", ids);
  if (error) throw error;
  const images = await Promise.all((data ?? []).map(async (item) => ({
    id: item.id,
    name: item.original_name,
    type: item.content_type,
    createdAt: item.created_at,
    url: await signedUrl(item.object_key),
    alertId: item.alert_id,
  })));
  return rows.map((row) => alertPayload(row, images.filter((image) => image.alertId === row.id).map(({ alertId: _alertId, ...image }) => image)));
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function authenticatedUser(req: Request): Promise<User | null> {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!token || !anonKey) return null;
  const client = createClient(supabaseUrl, anonKey);
  const { data } = await client.auth.getUser(token);
  return data.user ?? null;
}

async function profile(userId: string) {
  const { data, error } = await api.from("operator_profiles").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data as { user_id: string; war_name: string; rank: string; role: "admin" | "operator"; invited_by: string | null } | null;
}

async function operatorContext(req: Request, admin = false) {
  const user = await authenticatedUser(req);
  if (!user) return { response: fail("Sessão inválida ou expirada.", 401) } as const;
  const current = await profile(user.id);
  if (!current || (admin && current.role !== "admin")) return { response: fail("Acesso não autorizado.", 403) } as const;
  return { user, current } as const;
}

async function operatorPayload(user: User, current: { user_id: string; war_name: string; rank: string; role: "admin" | "operator"; invited_by: string | null }) {
  let invitedBy: string | null = null;
  if (current.invited_by) {
    const { data: inviter } = await api.from("operator_profiles").select("war_name,rank").eq("user_id", current.invited_by).maybeSingle();
    invitedBy = inviter
      ? [inviter.rank, inviter.war_name].filter(Boolean).join(" ")
      : "Operador não localizado";
  }
  return { id: user.id, name: current.war_name, warName: current.war_name, rank: current.rank, email: user.email ?? "", role: current.role, invitedBy };
}

async function findBootstrapInvite(token: string) {
  const cleanToken = token.trim();
  if (!cleanToken) return null;
  const { data, error } = await api.from("bootstrap_invites")
    .select("id,expires_at")
    .eq("token_hash", await sha256(cleanToken))
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error) throw error;
  return data as { id: number; expires_at: string } | null;
}

async function signedUrl(objectKey: string | null) {
  if (!objectKey) return null;
  const { data } = await api.storage.from(bucket).createSignedUrl(objectKey, 300);
  return data?.signedUrl ?? null;
}

async function peopleRows(ids?: number[]) {
  let query = api.from("people").select("*").order("created_at", { ascending: false });
  if (ids) query = query.in("id", ids);
  const { data, error } = await query;
  if (error) throw error;
  const rows = data ?? [];
  const personIds = rows.map((row) => row.id as number);
  if (!personIds.length) return [];
  const [addresses, approaches, seized, media, factions] = await Promise.all([
    api.from("addresses").select("*").in("person_id", personIds),
    api.from("approaches").select("*").in("person_id", personIds).order("occurred_at", { ascending: false }),
    api.from("seized_objects").select("*").in("person_id", personIds),
    api.from("person_media").select("*").in("person_id", personIds),
    api.from("factions").select("id,name"),
  ]);
  if (addresses.error || approaches.error || seized.error || media.error || factions.error) throw addresses.error ?? approaches.error ?? seized.error ?? media.error ?? factions.error;
  const factionMap = new Map((factions.data ?? []).map((row) => [row.id as number, row.name as string]));
  const mediaWithUrls = await Promise.all((media.data ?? []).map(async (row) => ({
    id: row.id,
    kind: row.kind,
    originalName: row.original_name,
    description: row.description,
    capturedAt: row.captured_at,
    url: await signedUrl(row.object_key),
  })));
  return rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    nickname: row.nickname,
    cpf: row.cpf,
    birthDate: row.birth_date,
    motherName: row.mother_name,
    city: row.city,
    state: row.state,
    status: row.status,
    custodyStatus: row.custody_status ?? "free",
    notes: row.notes,
    factionId: row.faction_id,
    factionName: row.faction_id ? factionMap.get(row.faction_id) ?? null : null,
    createdAt: row.created_at,
    addresses: (addresses.data ?? []).filter((item) => item.person_id === row.id).map((item) => ({ id: item.id, label: item.label, address: item.address, city: item.city ?? "", state: item.state ?? "", notes: item.notes ?? "" })),
    approaches: (approaches.data ?? []).filter((item) => item.person_id === row.id).map((item) => ({ id: item.id, occurredAt: item.occurred_at ?? null, latitude: item.latitude == null ? null : String(item.latitude), longitude: item.longitude == null ? null : String(item.longitude), accuracyMeters: item.accuracy_meters, locationLabel: item.location_label, notes: item.notes })),
    approachCount: (approaches.data ?? []).filter((item) => item.person_id === row.id).length,
    seizedObjects: (seized.data ?? []).filter((item) => item.person_id === row.id).map((item) => ({ id: item.id, description: item.description, quantity: item.quantity, seizedAt: item.seized_at ?? "", location: item.location ?? "", notes: item.notes ?? "" })),
    media: mediaWithUrls.filter((item) => (media.data ?? []).find((source) => source.id === item.id)?.person_id === row.id),
  }));
}

async function handleAuth(path: string, req: Request) {
  if (path === "/auth/status" && req.method === "GET") {
    const user = await authenticatedUser(req);
    if (!user) {
      const { count } = await api.from("operator_profiles").select("user_id", { count: "exact", head: true });
      const bootstrapToken = new URL(req.url).searchParams.get("bootstrap") ?? "";
      const invite = await findBootstrapInvite(bootstrapToken);
      const bootstrapAllowed = (count ?? 0) === 0 && (bootstrapToken ? Boolean(invite) : Boolean(Deno.env.get("SICC_BOOTSTRAP_KEY")));
      return json({ operator: null, bootstrapAllowed });
    }
    const current = await profile(user.id);
    return json({ operator: current ? await operatorPayload(user, current) : null, bootstrapAllowed: false });
  }
  if (path === "/auth/logout" && req.method === "POST") return json({ ok: true });
  if (path === "/auth/login" && req.method === "POST") {
    const body = await bodyJson(req);
    const client = createClient(supabaseUrl, anonKey);
    const { data, error } = await client.auth.signInWithPassword({ email: clean(String(body.email ?? "")), password: String(body.password ?? "") });
    if (error || !data.user || !data.session) return fail("E-mail ou senha inválidos.", 401);
    const current = await profile(data.user.id);
    if (!current) return fail("Sua conta ainda não foi provisionada como operador.", 403);
    return json({ ...await operatorPayload(data.user, current), access_token: data.session.access_token, refresh_token: data.session.refresh_token, expires_in: data.session.expires_in });
  }
  if (path === "/auth/bootstrap" && req.method === "POST") {
    const body = await bodyJson(req);
    const expected = Deno.env.get("SICC_BOOTSTRAP_KEY") ?? "";
    const { count } = await api.from("operator_profiles").select("user_id", { count: "exact", head: true });
    const bootstrapToken = clean(String(body.bootstrapInvite ?? ""));
    const invitation = await findBootstrapInvite(bootstrapToken);
    const legacyKeyValid = Boolean(expected) && String(body.bootstrapKey ?? "") === expected;
    if ((!legacyKeyValid && !invitation) || (count ?? 0) > 0) return fail("Ativação inicial indisponível.", 403);
    const { data: created, error } = await api.auth.admin.createUser({ email: clean(String(body.email ?? "")), password: String(body.password ?? ""), email_confirm: true });
    if (error || !created.user) return fail(error?.message ?? "Não foi possível criar a conta administradora.", 400);
    const { error: profileError } = await api.from("operator_profiles").insert({ user_id: created.user.id, war_name: clean(String(body.warName ?? "")), rank: clean(String(body.rank ?? "")), role: "admin" });
    if (profileError) {
      await api.auth.admin.deleteUser(created.user.id);
      return fail(profileError.message, 400);
    }
    if (invitation) {
      const { data: consumed, error: consumeError } = await api.from("bootstrap_invites")
        .update({ used_at: new Date().toISOString() })
        .eq("id", invitation.id)
        .is("used_at", null)
        .select("id")
        .maybeSingle();
      if (consumeError || !consumed) {
        await api.auth.admin.deleteUser(created.user.id);
        return fail("Este link de ativação já foi utilizado.", 409);
      }
    }
    const client = createClient(supabaseUrl, anonKey);
    const { data: session, error: loginError } = await client.auth.signInWithPassword({ email: clean(String(body.email ?? "")), password: String(body.password ?? "") });
    if (loginError || !session.session) return fail("Conta criada, mas não foi possível iniciar a sessão.", 500);
    return json({ ...await operatorPayload(created.user, { user_id: created.user.id, war_name: clean(String(body.warName ?? "")), rank: clean(String(body.rank ?? "")), role: "admin", invited_by: null }), access_token: session.session.access_token, refresh_token: session.session.refresh_token, expires_in: session.session.expires_in });
  }
  if (path === "/auth/invite-status" && req.method === "GET") {
    const code = clean(new URL(req.url).searchParams.get("code"));
    const { data } = await api.from("operator_invites").select("expires_at,used_at,revoked_at,invite_type").eq("code_hash", await sha256(code)).maybeSingle();
    if (!data) return json({ valid: false, reason: "invalid" });
    if (data.revoked_at) return json({ valid: false, reason: "revoked" });
    if (new Date(data.expires_at).getTime() <= Date.now()) return json({ valid: false, reason: "expired" });
    if (data.invite_type !== "bulk" && data.used_at) return json({ valid: false, reason: "used" });
    return json({ valid: true, kind: data.invite_type, expiresAt: data.expires_at });
  }
  if (path === "/auth/register" && req.method === "POST") {
    const body = await bodyJson(req);
    const invite = clean(String(body.invite ?? ""));
    const now = new Date().toISOString();
    const { data: invitationRows, error: invitationError } = await api.from("operator_invites")
      .select("id,created_by,invite_type,use_count,used_at,revoked_at,expires_at")
      .eq("code_hash", await sha256(invite));
    if (invitationError) return fail(invitationError.message, 500);
    const invitation = (invitationRows ?? []).find((row) =>
      row.revoked_at === null
      && new Date(row.expires_at).getTime() > Date.now()
      && (row.invite_type === "bulk" || row.used_at === null)
    );
    if (!invitation) return fail("Código de convite inválido, revogado, expirado ou já utilizado.", 400);
    const { data: created, error } = await api.auth.admin.createUser({ email: clean(String(body.email ?? "")), password: String(body.password ?? ""), email_confirm: true });
    if (error || !created.user) return fail(error?.message ?? "Não foi possível criar a conta.", 400);
    const { error: profileError } = await api.from("operator_profiles").insert({ user_id: created.user.id, war_name: clean(String(body.warName ?? "")), rank: clean(String(body.rank ?? "")), role: "operator", invited_by: invitation.created_by });
    if (profileError) {
      await api.auth.admin.deleteUser(created.user.id);
      return fail(profileError.message, 400);
    }
    if (invitation.invite_type === "bulk") {
      const { error: consumeError } = await api.from("operator_invites")
        .update({ use_count: (Number((invitation as { use_count?: number }).use_count) || 0) + 1 })
        .eq("id", invitation.id)
        .is("revoked_at", null)
        .gt("expires_at", now);
      if (consumeError) {
        await api.from("operator_profiles").delete().eq("user_id", created.user.id);
        await api.auth.admin.deleteUser(created.user.id);
        return fail("Não foi possível registrar o uso do convite.", 409);
      }
    } else {
      const { data: consumed, error: consumeError } = await api.from("operator_invites")
        .update({ used_at: now, used_by: created.user.id })
        .eq("id", invitation.id)
        .is("used_at", null)
        .select("id")
        .maybeSingle();
      if (consumeError || !consumed) {
        await api.from("operator_profiles").delete().eq("user_id", created.user.id);
        await api.auth.admin.deleteUser(created.user.id);
        return fail("Este convite já foi utilizado.", 409);
      }
    }
    const client = createClient(supabaseUrl, anonKey);
    const { data: session, error: loginError } = await client.auth.signInWithPassword({ email: clean(String(body.email ?? "")), password: String(body.password ?? "") });
    if (loginError || !session.session) return fail("Conta criada, mas não foi possível iniciar a sessão.", 500);
    return json({ ...await operatorPayload(created.user, { user_id: created.user.id, war_name: clean(String(body.warName ?? "")), rank: clean(String(body.rank ?? "")), role: "operator", invited_by: invitation.created_by }), access_token: session.session.access_token, refresh_token: session.session.refresh_token, expires_in: session.session.expires_in });
  }
  return null;
}

async function handleData(path: string, req: Request) {
  const adminOnly = path.startsWith("/admin/");
  const context = await operatorContext(req, adminOnly);
  if ("response" in context) return context.response;
  const { user, current } = context;
  if (path === "/factions" && req.method === "GET") {
    const { data, error } = await api.from("factions").select("id,name").order("name");
    return error ? fail(error.message, 500) : json({ factions: data ?? [] });
  }
  if (path === "/factions" && req.method === "POST") {
    const body = await bodyJson(req);
    const { data, error } = await api.from("factions").insert({ name: clean(String(body.name ?? "")) }).select("id,name").single();
    return error ? fail(error.message, 400) : json({ faction: data });
  }
  if (path === "/invites" && req.method === "GET") {
    const params = new URL(req.url).searchParams;
    const code = clean(params.get("code"));
    let query = api.from("operator_invites")
      .select("id,code,expires_at,used_at,invite_type,revoked_at,use_count")
      .eq("created_by", user.id)
      .order("created_at", { ascending: false });
    if (code) query = query.eq("code_hash", await sha256(code));
    const { data, error } = code ? await query.maybeSingle() : await query;
    if (error) return fail(error.message, 500);
    const rows = code ? (data ? [data] : []) : (data ?? []);
    const activeRows = rows.filter((row) =>
      new Date(row.expires_at).getTime() > Date.now()
      && row.revoked_at === null
      && (row.invite_type === "bulk" || row.used_at === null)
      && typeof row.code === "string" && row.code.length > 0
    );
    const invites = activeRows.map((row) => ({
      id: row.id,
      code: row.code,
      kind: row.invite_type,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
      revokedAt: row.revoked_at,
      useCount: row.use_count ?? 0,
    }));
    return code ? json({
      active: invites.length > 0,
      invite: invites[0] ?? null,
    }) : json({ invites });
  }
  if (path === "/invites" && req.method === "POST") {
    const body = await bodyJson(req);
    const kind = String(body.kind ?? "single").toLowerCase() === "bulk" ? "bulk" : "single";
    if (kind === "bulk" && current.role !== "admin") return fail("Somente administradores podem criar convites reutilizáveis.", 403);
    const code = randomCode();
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    const { data, error } = await api.from("operator_invites")
      .insert({ code_hash: await sha256(code), code, created_by: user.id, expires_at: expiresAt, invite_type: kind, use_count: 0 })
      .select("id")
      .single();
    return error || !data ? fail(error?.message ?? "Não foi possível gerar o convite.", 500) : json({ id: data.id, code, expiresAt, kind });
  }
  const inviteMatch = path.match(/^\/invites\/(\d+)$/);
  if (inviteMatch && req.method === "PATCH") {
    if (current.role !== "admin") return fail("Somente administradores podem revogar convites.", 403);
    const { error } = await api.from("operator_invites")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", Number(inviteMatch[1]))
      .eq("invite_type", "bulk")
      .is("revoked_at", null);
    return error ? fail(error.message, 400) : json({ revoked: true });
  }
  if (path === "/people" && req.method === "GET") {
    const url = new URL(req.url);
    if (url.searchParams.get("count") === "1") {
      const { count, error } = await api.from("people").select("id", { count: "exact", head: true });
      return error ? fail("Não foi possível obter o total de cadastros.", 500) : json({ total: count ?? 0 });
    }
    const id = Number(url.searchParams.get("id"));
    const q = clean(url.searchParams.get("q"));
    let ids: number[] | undefined;
    if (Number.isFinite(id) && id > 0) ids = [id];
    else if (q) {
      const cpfQuery = q.replace(/\D/g, "");
      const [name, nickname, mother, cpf] = await Promise.all([
        api.from("people").select("id").ilike("full_name", `%${q}%`),
        api.from("people").select("id").ilike("nickname", `%${q}%`),
        api.from("people").select("id").ilike("mother_name", `%${q}%`),
        api.from("people").select("id").eq("cpf", cpfQuery || q),
      ]);
      if (name.error || nickname.error || mother.error || cpf.error) return fail("Não foi possível consultar os cadastros.", 500);
      ids = [...new Set([...(name.data ?? []), ...(nickname.data ?? []), ...(mother.data ?? []), ...(cpf.data ?? [])].map((row) => row.id as number))];
    }
    const people = await peopleRows(ids);
    const { count, error: countError } = await api.from("people").select("id", { count: "exact", head: true });
    return countError ? fail("Não foi possível obter o total de cadastros.", 500) : json({ people, total: count ?? 0 });
  }
  if (path === "/people" && req.method === "POST") {
    const form = await req.formData();
    const cpf = clean(form.get("cpf")).replace(/\D/g, "");
    if (cpf.length !== 11) return fail("Informe um CPF válido com 11 dígitos.", 400);
    const { data: existingCpf, error: cpfError } = await api.from("people").select("id,full_name").eq("cpf", cpf).maybeSingle();
    if (cpfError) return fail("Não foi possível validar o CPF.", 500);
    if (existingCpf) return fail(`Já existe um cadastro para este CPF: ${existingCpf.full_name}.`, 409);
    const faction = await resolveFactionId(form);
    if (faction.error) return fail(faction.error, 400);
    const now = new Date().toISOString();
    const { data: person, error } = await api.from("people").insert({ full_name: clean(form.get("fullName")), nickname: clean(form.get("nickname")) || null, cpf, birth_date: clean(form.get("birthDate")) || null, mother_name: clean(form.get("motherName")) || null, city: clean(form.get("city")) || null, state: clean(form.get("state")) || null, status: clean(form.get("status")) === "dead" ? "dead" : "alive", custody_status: clean(form.get("custodyStatus")) === "detained" ? "detained" : "free", notes: clean(form.get("notes")) || null, faction_id: faction.id, created_by: user.id, created_at: now, updated_at: now }).select("id").single();
    if (error || !person) return fail(error?.message ?? "Não foi possível salvar o cadastro.", 400);
    try {
      const addresses = JSON.parse(String(form.get("addresses") ?? "[]")) as Array<Record<string, string>>;
      if (addresses.length) await api.from("addresses").insert(addresses.map((item) => ({ person_id: person.id, label: clean(item.label) || "Residencial", address: clean(item.address), city: clean(item.city) || null, state: clean(item.state) || null, notes: clean(item.notes) || null })));
      const seized = JSON.parse(String(form.get("seizedObjects") ?? "[]")) as Array<Record<string, string | number>>;
      if (seized.length) await api.from("seized_objects").insert(seized.map((item) => ({ person_id: person.id, description: clean(String(item.description)), quantity: Number(item.quantity) || 1, seized_at: clean(String(item.seizedAt)) || null, location: clean(String(item.location)) || null, notes: clean(String(item.notes)) || null })));
      const importedApproaches = JSON.parse(String(form.get("approaches") ?? "[]")) as Array<Record<string, unknown>>;
      if (importedApproaches.length) {
        const approachInsert = await api.from("approaches").insert(importedApproaches.map((item) => ({
          person_id: person.id,
          occurred_at: clean(String(item.occurredAt ?? "")) || new Date().toISOString(),
          latitude: Number.isFinite(Number(item.latitude)) ? Number(item.latitude) : null,
          longitude: Number.isFinite(Number(item.longitude)) ? Number(item.longitude) : null,
          accuracy_meters: Number(item.accuracyMeters) || null,
          location_label: clean(String(item.locationLabel ?? "")) || null,
          notes: clean(String(item.notes ?? "")) || "Importado do Infoseg",
          operator_id: user.id,
          operator_email: user.email ?? "",
        })));
        if (approachInsert.error) throw approachInsert.error;
      }
      const files = [...form.getAll("facePhotos"), ...form.getAll("tattoos")].filter((item): item is File => item instanceof File && item.size > 0);
      const kinds = form.getAll("facePhotos").filter((item): item is File => item instanceof File && item.size > 0).length;
      for (const [index, file] of files.entries()) {
        const objectKey = `${user.id}/${person.id}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        const upload = await api.storage.from(bucket).upload(objectKey, file, { contentType: file.type, upsert: false });
        if (upload.error) throw upload.error;
        const { error: mediaError } = await api.from("person_media").insert({ person_id: person.id, kind: index < kinds ? "face" : "tattoo", object_key: objectKey, original_name: file.name, content_type: file.type, byte_size: file.size, sha256: await sha256Bytes(await file.arrayBuffer()), description: null });
        if (mediaError) throw mediaError;
      }
    } catch (error) {
      await api.from("people").delete().eq("id", person.id);
      return fail(error instanceof Error ? error.message : "Não foi possível salvar os anexos.", 400);
    }
    return json({ person: (await peopleRows([person.id]))[0] });
  }
  const personMatch = path.match(/^\/people\/(\d+)(?:\/approaches)?$/);
  if (personMatch && path.endsWith("/approaches") && req.method === "POST") {
    const body = await bodyJson(req);
    const { error } = await api.from("approaches").insert({ person_id: Number(personMatch[1]), occurred_at: String(body.occurredAt ?? new Date().toISOString()), latitude: Number(body.latitude), longitude: Number(body.longitude), accuracy_meters: Number(body.accuracyMeters) || null, location_label: clean(String(body.locationLabel ?? "")) || null, notes: clean(String(body.notes ?? "")) || null, operator_id: user.id, operator_email: user.email ?? "" });
    return error ? fail(error.message, 400) : json({ ok: true });
  }
  if (personMatch && req.method === "DELETE") {
    const { data: media } = await api.from("person_media").select("object_key").eq("person_id", Number(personMatch[1]));
    if (media?.length) await api.storage.from(bucket).remove(media.map((row) => row.object_key));
    const { error } = await api.from("people").delete().eq("id", Number(personMatch[1]));
    return error ? fail(error.message, 400) : json({ deleted: true });
  }
  if (personMatch && req.method === "PUT") {
    const form = await req.formData();
    const personId = Number(personMatch[1]);
    const cpf = clean(form.get("cpf")).replace(/\D/g, "");
    if (cpf.length !== 11) return fail("Informe um CPF válido com 11 dígitos.", 400);
    const { data: existingCpf, error: cpfError } = await api.from("people").select("id,full_name").eq("cpf", cpf).neq("id", personId).maybeSingle();
    if (cpfError) return fail("Não foi possível validar o CPF.", 500);
    if (existingCpf) return fail(`Já existe outro cadastro para este CPF: ${existingCpf.full_name}.`, 409);
    const faction = await resolveFactionId(form);
    if (faction.error) return fail(faction.error, 400);

    const { error: updateError } = await api.from("people").update({
      full_name: clean(form.get("fullName")),
      nickname: clean(form.get("nickname")) || null,
      cpf,
      birth_date: clean(form.get("birthDate")) || null,
      mother_name: clean(form.get("motherName")) || null,
      city: clean(form.get("city")) || null,
      state: clean(form.get("state")) || null,
      status: clean(form.get("status")) === "dead" ? "dead" : "alive",
      custody_status: clean(form.get("custodyStatus")) === "detained" ? "detained" : "free",
      notes: clean(form.get("notes")) || null,
      faction_id: faction.id,
      updated_at: new Date().toISOString(),
    }).eq("id", personId);
    if (updateError) return fail(updateError.message, 400);

    try {
      const addresses = JSON.parse(String(form.get("addresses") ?? "[]")) as Array<Record<string, string>>;
      const addressDelete = await api.from("addresses").delete().eq("person_id", personId);
      if (addressDelete.error) throw addressDelete.error;
      if (addresses.length) {
        const addressInsert = await api.from("addresses").insert(addresses.map((item) => ({
          person_id: personId,
          label: clean(item.label) || "Residencial",
          address: clean(item.address),
          city: clean(item.city) || null,
          state: clean(item.state) || null,
          notes: clean(item.notes) || null,
        })));
        if (addressInsert.error) throw addressInsert.error;
      }

      const seized = JSON.parse(String(form.get("seizedObjects") ?? "[]")) as Array<Record<string, string | number>>;
      const seizedDelete = await api.from("seized_objects").delete().eq("person_id", personId);
      if (seizedDelete.error) throw seizedDelete.error;
      if (seized.length) {
        const seizedInsert = await api.from("seized_objects").insert(seized.map((item) => ({
          person_id: personId,
          description: clean(String(item.description)),
          quantity: Number(item.quantity) || 1,
          seized_at: clean(String(item.seizedAt)) || null,
          location: clean(String(item.location)) || null,
          notes: clean(String(item.notes)) || null,
        })));
        if (seizedInsert.error) throw seizedInsert.error;
      }

      const removeIds = JSON.parse(String(form.get("removeMediaIds") ?? "[]")) as number[];
      const validRemoveIds = removeIds.filter((id) => Number.isInteger(id) && id > 0);
      if (validRemoveIds.length) {
        const { data: mediaToRemove, error: mediaLookupError } = await api.from("person_media")
          .select("id,object_key")
          .eq("person_id", personId)
          .in("id", validRemoveIds);
        if (mediaLookupError) throw mediaLookupError;
        const keys = (mediaToRemove ?? []).map((item) => item.object_key).filter(Boolean);
        if (keys.length) await api.storage.from(bucket).remove(keys);
        const mediaDelete = await api.from("person_media").delete().eq("person_id", personId).in("id", validRemoveIds);
        if (mediaDelete.error) throw mediaDelete.error;
      }

      const faceFiles = form.getAll("facePhotos").filter((item): item is File => item instanceof File && item.size > 0);
      const tattooFiles = form.getAll("tattoos").filter((item): item is File => item instanceof File && item.size > 0);
      const mediaFiles = [
        ...faceFiles.map((file) => ({ file, kind: "face" as const, capturedAt: clean(form.get("facePhotoDate")) || null })),
        ...tattooFiles.map((file) => ({ file, kind: "tattoo" as const, capturedAt: clean(form.get("tattooPhotoDate")) || null })),
      ];
      for (const item of mediaFiles) {
        const file = item.file;
        const objectKey = `${user.id}/${personId}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        const upload = await api.storage.from(bucket).upload(objectKey, file, { contentType: file.type, upsert: false });
        if (upload.error) throw upload.error;
        const mediaInsert = await api.from("person_media").insert({
          person_id: personId,
          kind: item.kind,
          object_key: objectKey,
          original_name: file.name,
          content_type: file.type,
          byte_size: file.size,
          sha256: await sha256Bytes(await file.arrayBuffer()),
          captured_at: item.capturedAt,
          description: null,
        });
        if (mediaInsert.error) throw mediaInsert.error;
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Não foi possível salvar os dados complementares.", 400);
    }
    return json({ person: (await peopleRows([personId]))[0] });
  }
  if (path === "/alerts" && req.method === "GET") {
    const params = new URL(req.url).searchParams;
    let query = api.from("qtc_alerts").select("*").order("created_at", { ascending: false }).limit(100);
    if (params.get("category")) query = query.eq("category_key", params.get("category"));
    if (params.get("municipality")) query = query.ilike("municipality", `%${params.get("municipality")}%`);
    if (params.get("neighborhood")) query = query.ilike("neighborhood", `%${params.get("neighborhood")}%`);
    if (params.get("status")) query = query.eq("status", params.get("status"));
    const { data, error } = await query;
    return error ? fail(error.message, 500) : json({ alerts: await alertRows((data ?? []) as Array<Record<string, unknown>>) });
  }
  if (path === "/alerts" && req.method === "POST") {
    const form = await req.formData();
    const category = alertCategories[clean(form.get("categoryKey"))] ?? alertCategories.outros;
    const { data, error } = await api.from("qtc_alerts").insert({ category_key: clean(form.get("categoryKey")), category_label: category.label, priority: category.priority, municipality: clean(form.get("municipality")), municipality_state: clean(form.get("municipalityState")), neighborhood: clean(form.get("neighborhood")), people_info: clean(form.get("peopleInfo")) || null, vehicle_info: clean(form.get("vehicleInfo")) || null, description: clean(form.get("description")), occurred_at: clean(form.get("occurredAt")) || new Date().toISOString(), location_link: clean(form.get("locationLink")) || null, status: "open", created_by: user.id, created_by_name: current.war_name }).select("*").single();
    if (error || !data) return fail(error?.message ?? "Não foi possível publicar o alerta.", 400);
    const files = form.getAll("images").filter((item): item is File => item instanceof File && item.size > 0);
    for (const file of files) {
      const objectKey = `${user.id}/alerts/${data.id}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const upload = await api.storage.from(bucket).upload(objectKey, file, { contentType: file.type, upsert: false });
      if (upload.error) return fail(upload.error.message, 400);
      const media = await api.from("qtc_alert_media").insert({ alert_id: data.id, object_key: objectKey, original_name: file.name, content_type: file.type, byte_size: file.size, sha256: await sha256Bytes(await file.arrayBuffer()) });
      if (media.error) return fail(media.error.message, 400);
    }
    // The QTC response must not wait for the push provider. Supabase keeps the
    // dispatch alive after the HTTP response through EdgeRuntime.waitUntil.
    EdgeRuntime.waitUntil(notifyNewQtc(category.label, category.priority, user.id));
    return json({ alert: (await alertRows([data as Record<string, unknown>]))[0] });
  }
  const alertMatch = path.match(/^\/alerts\/(\d+)$/);
  if (alertMatch && req.method === "PATCH") {
    const body = await bodyJson(req); const resolved = body.status === "resolved";
    const { error } = await api.from("qtc_alerts").update(resolved ? { status: "resolved", resolved_by: user.id, resolved_by_name: current.war_name, resolved_at: new Date().toISOString() } : { status: "open", resolved_by: null, resolved_by_name: null, resolved_at: null }).eq("id", Number(alertMatch[1]));
    return error ? fail(error.message, 400) : json({ ok: true });
  }
  if (alertMatch && req.method === "DELETE") {
    const { data: media } = await api.from("qtc_alert_media").select("object_key").eq("alert_id", Number(alertMatch[1]));
    if (media?.length) await api.storage.from(bucket).remove(media.map((row) => row.object_key));
    const { error } = await api.from("qtc_alerts").delete().eq("id", Number(alertMatch[1]));
    return error ? fail(error.message, 400) : json({ deleted: true });
  }
  if (path === "/admin/records" && req.method === "GET") {
    const page = Math.max(1, Number(new URL(req.url).searchParams.get("page") ?? 1) || 1);
    const from = (page - 1) * 10;
    const to = from + 9;
    const { data, error, count } = await api.from("people")
      .select("id,full_name,cpf,status,created_by,created_at", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, to);
    if (error) return fail(error.message, 500);
    const creatorIds = [...new Set((data ?? []).map((row) => row.created_by).filter(Boolean))] as string[];
    const [{ data: creatorProfiles, error: profilesError }, usersResult] = await Promise.all([
      creatorIds.length ? api.from("operator_profiles").select("user_id,war_name,rank").in("user_id", creatorIds) : Promise.resolve({ data: [], error: null }),
      api.auth.admin.listUsers({ page: 1, perPage: 1000 }),
    ]);
    if (profilesError || usersResult.error) return fail(profilesError?.message ?? usersResult.error?.message ?? "Não foi possível identificar os responsáveis pelos cadastros.", 500);
    const profileById = new Map((creatorProfiles ?? []).map((row) => [row.user_id as string, row]));
    const userById = new Map((usersResult.data?.users ?? []).map((item) => [item.id, item]));
    const rows = (data ?? []).map((row) => {
      const creator = profileById.get(row.created_by as string);
      const authUser = userById.get(row.created_by as string);
      const creatorName = creator ? [creator.rank, creator.war_name].filter(Boolean).join(" ") : (authUser?.email ?? null);
      return {
        id: row.id,
        name: row.full_name,
        cpf: row.cpf,
        status: row.status,
        createdAt: row.created_at,
        createdBy: creatorName,
        createdByName: creatorName,
      };
    });
    return json({ rows, total: count ?? 0 });
  }
  if (path === "/admin/operators" && req.method === "GET") {
    const page = Math.max(1, Number(new URL(req.url).searchParams.get("page") ?? 1) || 1);
    const from = (page - 1) * 10;
    const to = from + 9;
    const { data, error, count } = await api.from("operator_profiles")
      .select("user_id,war_name,rank,role,invited_by,created_at", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, to);
    if (error) return fail(error.message, 500);
    const profiles = data ?? [];
    const invitedIds = [...new Set(profiles.map((row) => row.invited_by).filter(Boolean))] as string[];
    const [{ data: invitedProfiles, error: invitedError }, usersResult] = await Promise.all([
      invitedIds.length ? api.from("operator_profiles").select("user_id,war_name,rank").in("user_id", invitedIds) : Promise.resolve({ data: [], error: null }),
      api.auth.admin.listUsers({ page: 1, perPage: 1000 }),
    ]);
    if (invitedError || usersResult.error) return fail(invitedError?.message ?? usersResult.error?.message ?? "Não foi possível carregar os operadores.", 500);
    const invitedById = new Map((invitedProfiles ?? []).map((row) => [row.user_id as string, row]));
    const userById = new Map((usersResult.data?.users ?? []).map((item) => [item.id, item]));
    const rows = profiles.map((row) => {
      const user = userById.get(row.user_id as string);
      const inviter = row.invited_by ? invitedById.get(row.invited_by as string) : null;
      const invitedBy = inviter ? [inviter.rank, inviter.war_name].filter(Boolean).join(" ") : (row.invited_by ? (userById.get(row.invited_by as string)?.email ?? null) : null);
      return {
        id: row.user_id,
        name: row.war_name,
        warName: row.war_name,
        rank: row.rank,
        email: user?.email ?? "",
        role: row.role,
        invitedBy,
        createdAt: row.created_at,
      };
    });
    return json({ rows, total: count ?? 0 });
  }
  if (path === "/admin/operators" && req.method === "DELETE") {
    const id = new URL(req.url).searchParams.get("id");
    if (!id || id === user.id) return fail("Operador inválido.", 400);
    const { error } = await api.auth.admin.deleteUser(id);
    return error ? fail(error.message, 400) : json({ deleted: true });
  }
  if (path === "/face-index" || path === "/search-image") return fail("A busca por imagem será habilitada após a migração do índice vetorial para Supabase.", 501);
  return fail("Endpoint não encontrado.", 404);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  try {
    const url = new URL(req.url);
    const marker = "/sicc-api";
    const path = (url.pathname.includes(marker) ? url.pathname.slice(url.pathname.indexOf(marker) + marker.length) || "/" : url.pathname).replace(/\/+$/, "") || "/";
    const auth = await handleAuth(path, req);
    if (!auth && path === "/") return json({ ok: true, service: "sicc-api" });
    return auth ?? await handleData(path, req);
  } catch (error) {
    console.error(error);
    return fail(error instanceof Error ? error.message : "Erro interno da API.", 500);
  }
});

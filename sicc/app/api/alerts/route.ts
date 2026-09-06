import { ALERT_CATEGORIES } from "../../alert-categories";
import { database, requireSession, storageWritesEnabled } from "../../auth";
import { LOCALITIES, LOCALITY_STATES } from "../../localities";

export const dynamic = "force-dynamic";

function bucket() {
  const binding = (globalThis as typeof globalThis & { __SICC_BUCKET?: R2Bucket }).__SICC_BUCKET;
  if (!binding) throw new Error("Armazenamento de imagens indisponível.");
  return binding;
}

async function ensureSchema() {
  const db = database();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS qtc_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_key TEXT NOT NULL,
      category_label TEXT NOT NULL,
      priority TEXT NOT NULL,
      municipality TEXT NOT NULL,
      municipality_state TEXT,
      neighborhood TEXT,
      people_info TEXT,
      vehicle_info TEXT,
      description TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      location_link TEXT,
      latitude TEXT,
      longitude TEXT,
      accuracy_meters INTEGER,
      status TEXT NOT NULL DEFAULT 'open',
      created_by TEXT NOT NULL,
      created_by_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_by TEXT,
      resolved_by_name TEXT,
      resolved_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS qtc_alert_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id INTEGER NOT NULL,
      object_key TEXT NOT NULL UNIQUE,
      original_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operator_email TEXT NOT NULL,
      action TEXT NOT NULL,
      target_id INTEGER,
      query TEXT,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS qtc_alerts_created_idx ON qtc_alerts(created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS qtc_alerts_category_idx ON qtc_alerts(category_key)"),
    db.prepare("CREATE INDEX IF NOT EXISTS qtc_alerts_municipality_idx ON qtc_alerts(municipality)"),
    db.prepare("CREATE INDEX IF NOT EXISTS qtc_alert_media_alert_idx ON qtc_alert_media(alert_id)"),
  ]);
  const columns = await db.prepare("PRAGMA table_info(qtc_alerts)").all<{ name: string }>();
  if (!columns.results.some((column) => column.name === "occurred_at")) {
    await db.prepare("ALTER TABLE qtc_alerts ADD COLUMN occurred_at TEXT").run();
    await db.prepare("UPDATE qtc_alerts SET occurred_at = created_at WHERE occurred_at IS NULL").run();
  }
  if (!columns.results.some((column) => column.name === "location_link")) {
    await db.prepare("ALTER TABLE qtc_alerts ADD COLUMN location_link TEXT").run();
  }
  if (!columns.results.some((column) => column.name === "neighborhood")) {
    await db.prepare("ALTER TABLE qtc_alerts ADD COLUMN neighborhood TEXT").run();
  }
  if (!columns.results.some((column) => column.name === "municipality_state")) {
    await db.prepare("ALTER TABLE qtc_alerts ADD COLUMN municipality_state TEXT").run();
  }
  const legacyRows = await db.prepare("SELECT id, municipality FROM qtc_alerts WHERE municipality_state IS NULL").all<{ id: number; municipality: string }>();
  for (const row of legacyRows.results ?? []) {
    const state = LOCALITY_STATES[row.municipality];
    if (state) await db.prepare("UPDATE qtc_alerts SET municipality_state = ? WHERE id = ?").bind(state, row.id).run();
  }
}

function text(value: FormDataEntryValue | null) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validCategory(key: string) {
  return ALERT_CATEGORIES.find((category) => category.key === key) ?? null;
}

async function hashFile(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeSearch(value: string | null | undefined) {
  return (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

async function alertRows(filters?: { category?: string; municipality?: string; neighborhood?: string; status?: string }) {
  const db = database();
  const conditions: string[] = [];
  const values: string[] = [];
  if (filters?.category) { conditions.push("category_key = ?"); values.push(filters.category); }
  if (filters?.status === "open" || filters?.status === "resolved") { conditions.push("status = ?"); values.push(filters.status); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = await db.prepare(`SELECT id, category_key, category_label, priority, municipality, municipality_state, neighborhood, people_info, vehicle_info, description, occurred_at, location_link, latitude, longitude, accuracy_meters, status, created_by, created_by_name, created_at, resolved_by, resolved_by_name, resolved_at FROM qtc_alerts ${where} ORDER BY created_at DESC, id DESC`).bind(...values).all<{
    id: number; category_key: string; category_label: string; priority: string; municipality: string; municipality_state: "PB" | "RN" | null; neighborhood: string | null; people_info: string | null; vehicle_info: string | null; description: string; occurred_at: string | null; location_link: string | null; latitude: string | null; longitude: string | null; accuracy_meters: number | null; status: string; created_by: string; created_by_name: string; created_at: string; resolved_by: string | null; resolved_by_name: string | null; resolved_at: string | null;
  }>();
  const alerts = query.results ?? [];
  if (!alerts.length) return [];
  const ids = alerts.map((alert) => alert.id);
  const placeholders = ids.map(() => "?").join(",");
  const media = await db.prepare(`SELECT id, alert_id, original_name, content_type, created_at FROM qtc_alert_media WHERE alert_id IN (${placeholders}) ORDER BY id`).bind(...ids).all<{ id: number; alert_id: number; original_name: string; content_type: string; created_at: string }>();
  const mediaByAlert = new Map<number, typeof media.results>();
  for (const item of media.results ?? []) {
    const items = mediaByAlert.get(item.alert_id) ?? [];
    items.push(item);
    mediaByAlert.set(item.alert_id, items);
  }
  const mapped = alerts.map((alert) => ({
    id: alert.id,
    categoryKey: alert.category_key,
    categoryLabel: alert.category_label,
    priority: alert.priority,
    municipality: alert.municipality,
    municipalityState: alert.municipality_state ?? LOCALITY_STATES[alert.municipality] ?? null,
    neighborhood: alert.neighborhood,
    peopleInfo: alert.people_info,
    vehicleInfo: alert.vehicle_info,
    description: alert.description,
    occurredAt: alert.occurred_at ?? alert.created_at,
    locationLink: alert.location_link,
    latitude: alert.latitude,
    longitude: alert.longitude,
    accuracyMeters: alert.accuracy_meters,
    status: alert.status,
    createdBy: alert.created_by,
    createdByName: alert.created_by_name,
    createdAt: alert.created_at,
    resolvedBy: alert.resolved_by,
    resolvedByName: alert.resolved_by_name,
    resolvedAt: alert.resolved_at,
    images: (mediaByAlert.get(alert.id) ?? []).map((item) => ({ id: item.id, name: item.original_name, type: item.content_type, createdAt: item.created_at, url: `/api/alerts/media/${item.id}` })),
  }));
  const municipality = normalizeSearch(filters?.municipality);
  const neighborhood = normalizeSearch(filters?.neighborhood);
  return mapped.filter((alert) => (!municipality || normalizeSearch(alert.municipality).includes(municipality)) && (!neighborhood || normalizeSearch(alert.neighborhood).includes(neighborhood)));
}

export async function GET(request: Request) {
  if (!await requireSession()) return Response.json({ error: "Acesso não autenticado." }, { status: 401 });
  await ensureSchema();
  const params = new URL(request.url).searchParams;
  return Response.json({ alerts: await alertRows({ category: params.get("category") || undefined, municipality: params.get("municipality") || undefined, neighborhood: params.get("neighborhood") || undefined, status: params.get("status") || undefined }) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const operator = await requireSession();
  if (!operator) return Response.json({ error: "Acesso não autenticado." }, { status: 401 });
  await ensureSchema();
  const form = await request.formData();
  const categoryKey = text(form.get("categoryKey"));
  const category = categoryKey ? validCategory(categoryKey) : null;
  const municipalityState = text(form.get("municipalityState"));
  const municipality = text(form.get("municipality"));
  const neighborhood = text(form.get("neighborhood"));
  const description = text(form.get("description"));
  const occurredAt = text(form.get("occurredAt"));
  const locationLink = text(form.get("locationLink"));
  if (!category || !municipalityState || !municipality || !neighborhood || !description || !occurredAt) return Response.json({ error: "Categoria, estado, cidade, bairro, data/hora da ocorrência e descrição são obrigatórios." }, { status: 400 });
  if (!(municipalityState === "PB" || municipalityState === "RN") || !Object.prototype.hasOwnProperty.call(LOCALITIES, municipality) || LOCALITY_STATES[municipality] !== municipalityState || !LOCALITIES[municipality].includes(neighborhood)) return Response.json({ error: "Selecione um estado, cidade e bairro das listas predefinidas." }, { status: 400 });
  if (locationLink) {
    try {
      const parsed = new URL(locationLink);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("invalid protocol");
    } catch {
      return Response.json({ error: "O link de localização deve começar com http:// ou https://." }, { status: 400 });
    }
  }
  const files = form.getAll("images").filter((item): item is File => item instanceof File && item.size > 0);
  if (files.length && !storageWritesEnabled()) return Response.json({ error: "Armazenamento de imagens ainda não foi habilitado pelo administrador." }, { status: 503 });
  if (files.some((file) => !["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 2_500_000)) return Response.json({ error: "Cada imagem deve ser JPG, PNG ou WEBP e ter no máximo 2,5 MB." }, { status: 400 });
  const now = new Date().toISOString();
  const createdByName = operator.name || operator.email;
  const result = await database().prepare(`INSERT INTO qtc_alerts (category_key, category_label, priority, municipality, municipality_state, neighborhood, people_info, vehicle_info, description, occurred_at, location_link, latitude, longitude, accuracy_meters, status, created_by, created_by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`).bind(category.key, category.label, category.priority, municipality, municipalityState, neighborhood, text(form.get("peopleInfo")), text(form.get("vehicleInfo")), description, occurredAt, locationLink, null, null, null, operator.email, createdByName, now).run();
  const alertId = Number(result.meta.last_row_id);
  try {
    for (const [index, file] of files.entries()) {
      const digest = await hashFile(file);
      const objectKey = `alerts/${alertId}/${Date.now()}-${index}-${digest.slice(0, 16)}`;
      await bucket().put(objectKey, file, { httpMetadata: { contentType: file.type }, customMetadata: { originalName: file.name } });
      await database().prepare("INSERT INTO qtc_alert_media (alert_id, object_key, original_name, content_type, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(alertId, objectKey, file.name, file.type, digest, now).run();
    }
  } catch {
    await database().prepare("DELETE FROM qtc_alert_media WHERE alert_id = ?").bind(alertId).run();
    await database().prepare("DELETE FROM qtc_alerts WHERE id = ?").bind(alertId).run();
    return Response.json({ error: "Não foi possível armazenar as imagens do QTC." }, { status: 500 });
  }
  await database().prepare("INSERT INTO audit_logs (operator_email, action, target_id, query, created_at) VALUES (?, ?, ?, ?, ?)").bind(operator.email, "CREATE_ALERT", alertId, category.label, now).run().catch(() => undefined);
  const alerts = await alertRows();
  return Response.json({ alert: alerts.find((item) => item.id === alertId) ?? null }, { status: 201 });
}

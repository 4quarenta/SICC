import { requireSession, storageWritesEnabled } from "../../auth";

export const dynamic = "force-dynamic";

type Status = "verified" | "review" | "attention";
type PersonRow = {
  id: number;
  full_name: string;
  nickname: string | null;
  cpf: string;
  birth_date: string | null;
  mother_name: string | null;
  city: string | null;
  state: string | null;
  status: Status;
  notes: string | null;
  faction_id: number | null;
  faction_name: string | null;
  created_at: string;
};

type AddressInput = {
  label?: string;
  address?: string;
  city?: string;
  state?: string;
  notes?: string;
};

type SeizedObjectInput = {
  description?: string;
  quantity?: number;
  seizedAt?: string;
  location?: string;
  notes?: string;
};

const personColumns =
  "id, full_name, nickname, cpf, birth_date, mother_name, city, state, status, notes, faction_id, (SELECT name FROM factions WHERE id = people.faction_id) AS faction_name, created_at";

function database() {
  const binding = (globalThis as typeof globalThis & { __SICC_DB?: D1Database }).__SICC_DB;
  if (!binding) throw new Error("Banco de dados indisponível.");
  return binding;
}

function bucket() {
  const binding = (globalThis as typeof globalThis & { __SICC_BUCKET?: R2Bucket }).__SICC_BUCKET;
  if (!binding) throw new Error("Armazenamento de imagens indisponível.");
  return binding;
}

async function operatorEmail() {
  return (await requireSession())?.email ?? null;
}

async function ensureSchema() {
  const db = database();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      nickname TEXT,
      cpf TEXT NOT NULL UNIQUE,
      birth_date TEXT,
      mother_name TEXT,
      city TEXT,
      state TEXT,
      status TEXT NOT NULL DEFAULT 'review',
      notes TEXT,
      faction_id INTEGER,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operator_email TEXT NOT NULL,
      action TEXT NOT NULL,
      target_id INTEGER,
      query TEXT,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL,
      label TEXT NOT NULL DEFAULT 'Residencial',
      address TEXT NOT NULL,
      city TEXT,
      state TEXT,
      notes TEXT,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS approaches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL,
      occurred_at TEXT NOT NULL,
      latitude TEXT NOT NULL,
      longitude TEXT NOT NULL,
      accuracy_meters INTEGER,
      location_label TEXT,
      notes TEXT,
      operator_email TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS seized_objects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL,
      description TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      seized_at TEXT,
      location TEXT,
      notes TEXT,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS person_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      object_key TEXT NOT NULL UNIQUE,
      original_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      visual_hash TEXT,
      face_embedding TEXT,
      description TEXT,
      captured_at TEXT,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS factions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS people_full_name_idx ON people(full_name)"),
    db.prepare("CREATE INDEX IF NOT EXISTS addresses_person_idx ON addresses(person_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS approaches_person_idx ON approaches(person_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS approaches_date_idx ON approaches(occurred_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS seized_objects_person_idx ON seized_objects(person_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS person_media_person_idx ON person_media(person_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS person_media_hash_idx ON person_media(sha256)"),
    db.prepare("CREATE INDEX IF NOT EXISTS audit_created_at_idx ON audit_logs(created_at)"),
  ]);

  const columns = await db.prepare("PRAGMA table_info(people)").all<{ name: string }>();
  if (!columns.results.some((column) => column.name === "nickname")) {
    await db.prepare("ALTER TABLE people ADD COLUMN nickname TEXT").run();
  }
  const mediaColumns = await db.prepare("PRAGMA table_info(person_media)").all<{ name: string }>();
  if (!mediaColumns.results.some((column) => column.name === "visual_hash")) {
    await db.prepare("ALTER TABLE person_media ADD COLUMN visual_hash TEXT").run();
  }
  const refreshedMediaColumns = await db.prepare("PRAGMA table_info(person_media)").all<{ name: string }>();
  if (!refreshedMediaColumns.results.some((column) => column.name === "face_embedding")) {
    await db.prepare("ALTER TABLE person_media ADD COLUMN face_embedding TEXT").run();
  }
  if (!columns.results.some((column) => column.name === "faction_id")) {
    await db.prepare("ALTER TABLE people ADD COLUMN faction_id INTEGER").run();
  }
  const addressColumns = await db.prepare("PRAGMA table_info(addresses)").all<{ name: string }>();
  if (!addressColumns.results.some((column) => column.name === "notes")) {
    await db.prepare("ALTER TABLE addresses ADD COLUMN notes TEXT").run();
  }
  const finalMediaColumns = await db.prepare("PRAGMA table_info(person_media)").all<{ name: string }>();
  if (!finalMediaColumns.results.some((column) => column.name === "captured_at")) {
    await db.prepare("ALTER TABLE person_media ADD COLUMN captured_at TEXT").run();
  }
  await db.prepare("CREATE INDEX IF NOT EXISTS people_nickname_idx ON people(nickname)").run();
}

function parseJsonArray<T>(value: FormDataEntryValue | null): T[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function cleanText(value: FormDataEntryValue | null) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function hashFile(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function saveMedia(personId: number, kind: string, files: File[], now: string, capturedAt: string | null, visualHashes: string[] = [], faceEmbeddings: Array<number[] | null> = []) {
  if (files.some((file) => file.size > 0) && !storageWritesEnabled()) throw new Error("STORAGE_WRITES_DISABLED");
  const db = database();
  for (const [index, file] of files.entries()) {
    if (!file.size) continue;
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const objectKey = `people/${personId}/${crypto.randomUUID()}-${safeName}`;
    const sha256 = await hashFile(file);
    await bucket().put(objectKey, file, {
      httpMetadata: { contentType: file.type },
      customMetadata: { personId: String(personId), kind },
    });
    await db.prepare(`INSERT INTO person_media
      (person_id, kind, object_key, original_name, content_type, sha256, visual_hash, face_embedding, captured_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(personId, kind, objectKey, file.name, file.type, sha256, visualHashes[index] || null, faceEmbeddings[index]?.length === 128 ? JSON.stringify(faceEmbeddings[index]) : null, capturedAt, now).run();
  }
}

function validateMedia(files: File[]) {
  const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
  if (files.some((file) => file.size && (!allowedTypes.has(file.type) || file.size > 5 * 1024 * 1024))) {
    throw new Error("MEDIA_INVALID");
  }
}

async function toPerson(row: PersonRow) {
  const db = database();
  const [addresses, approaches, seizedObjects, media] = await Promise.all([
    db.prepare("SELECT id, label, address, city, state, notes FROM addresses WHERE person_id = ? ORDER BY id DESC").bind(row.id).all(),
    db.prepare("SELECT id, occurred_at AS occurredAt, latitude, longitude, accuracy_meters AS accuracyMeters, location_label AS locationLabel, notes FROM approaches WHERE person_id = ? ORDER BY occurred_at DESC").bind(row.id).all(),
    db.prepare("SELECT id, description, quantity, seized_at AS seizedAt, location, notes FROM seized_objects WHERE person_id = ? ORDER BY seized_at DESC, id DESC").bind(row.id).all(),
    db.prepare("SELECT id, kind, original_name AS originalName, description, captured_at AS capturedAt FROM person_media WHERE person_id = ? ORDER BY COALESCE(captured_at, created_at) DESC, id DESC").bind(row.id).all<{ id: number; kind: string; originalName: string; description: string | null; capturedAt: string | null }>(),
  ]);
  return {
    id: row.id,
    fullName: row.full_name,
    nickname: row.nickname,
    cpf: row.cpf,
    birthDate: row.birth_date,
    motherName: row.mother_name,
    city: row.city,
    state: row.state,
    status: row.status,
    notes: row.notes,
    factionId: row.faction_id,
    factionName: row.faction_name,
    createdAt: row.created_at,
    addresses: addresses.results,
    approaches: approaches.results,
    approachCount: approaches.results.length,
    seizedObjects: seizedObjects.results,
    media: media.results.map((item) => ({ ...item, url: `/api/media/${item.id}` })),
  };
}

export async function GET(request: Request) {
  const operator = await operatorEmail();
  if (!operator) return Response.json({ error: "Acesso não autenticado." }, { status: 401 });
  await ensureSchema();
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim();
  const requestedId = Number(url.searchParams.get("id") ?? 0);
  const recent = url.searchParams.get("recent") === "1";
  const db = database();

  if (!recent && !requestedId && query.length < 3) {
    return Response.json({ error: "Informe ao menos 3 caracteres." }, { status: 400 });
  }

  const digits = query.replace(/\D/g, "");
  const statement = requestedId
    ? db.prepare(`SELECT ${personColumns} FROM people WHERE id = ? LIMIT 1`).bind(requestedId)
    : recent
    ? db.prepare(`SELECT ${personColumns} FROM people ORDER BY created_at DESC LIMIT 20`)
    : db.prepare(`SELECT ${personColumns} FROM people
        WHERE lower(full_name) LIKE lower(?)
           OR lower(COALESCE(nickname, '')) LIKE lower(?)
           OR cpf LIKE ?
        ORDER BY full_name LIMIT 30`)
      .bind(`%${query}%`, `%${query}%`, `%${digits || query}%`);

  const result = await statement.all<PersonRow>();
  if (!recent) {
    await db.prepare("INSERT INTO audit_logs (operator_email, action, target_id, query, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(operator, requestedId ? "VIEW_PERSON" : "SEARCH_TEXT", requestedId || null, requestedId ? null : query, new Date().toISOString()).run();
  }
  return Response.json({ people: await Promise.all(result.results.map(toPerson)) });
}

export async function POST(request: Request) {
  const operator = await operatorEmail();
  if (!operator) return Response.json({ error: "Acesso não autenticado." }, { status: 401 });
  await ensureSchema();
  const db = database();
  const form = await request.formData();
  const fullName = cleanText(form.get("fullName")) ?? "";
  const nickname = cleanText(form.get("nickname"));
  const cpf = (cleanText(form.get("cpf")) ?? "").replace(/\D/g, "");
  if (fullName.length < 3) return Response.json({ error: "Informe o nome completo." }, { status: 400 });
  if (cpf.length !== 11) return Response.json({ error: "Informe um CPF com 11 dígitos." }, { status: 400 });

  const statusValue = cleanText(form.get("status"));
  const status: Status = statusValue === "verified" || statusValue === "attention" ? statusValue : "review";
  const source = cleanText(form.get("source")) ?? "administrative";
  const latitude = cleanText(form.get("latitude"));
  const longitude = cleanText(form.get("longitude"));
  if (source === "approach" && (!latitude || !longitude)) {
    return Response.json({ error: "Capture a localização atual para registrar uma abordagem." }, { status: 400 });
  }

  const addresses = parseJsonArray<AddressInput>(form.get("addresses"));
  const seizedObjects = parseJsonArray<SeizedObjectInput>(form.get("seizedObjects"));
  const facePhotos = form.getAll("facePhotos").filter((item): item is File => item instanceof File);
  const tattoos = form.getAll("tattoos").filter((item): item is File => item instanceof File);
  const facePhotoHashes = parseJsonArray<string>(form.get("facePhotoHashes"));
  const tattooHashes = parseJsonArray<string>(form.get("tattooHashes"));
  const faceEmbeddings = parseJsonArray<number[]>(form.get("faceEmbeddings"));
  const mediaFiles = [
    ...facePhotos,
    ...tattoos,
  ];
  if (!facePhotos.length || !cleanText(form.get("facePhotoDate"))) {
    return Response.json({ error: "Adicione ao menos uma foto do rosto e informe a data da foto." }, { status: 400 });
  }
  if (tattoos.some((file) => file.size > 0) && !cleanText(form.get("tattooPhotoDate"))) {
    return Response.json({ error: "Informe a data das fotos de tatuagens adicionadas." }, { status: 400 });
  }
  try {
    validateMedia(mediaFiles);
  } catch {
    return Response.json({ error: "Use imagens JPG, PNG ou WEBP de até 5 MB cada." }, { status: 400 });
  }
  const now = new Date().toISOString();
  let createdId: number | null = null;

  try {
    let factionId: number | null = null;
    if (cleanText(form.get("factionAffiliated")) === "yes") {
      const selectedFactionId = Number(cleanText(form.get("factionId")) || 0);
      const newFactionName = cleanText(form.get("newFactionName"));
      if (newFactionName) {
        factionId = (await db.prepare("SELECT id FROM factions WHERE lower(name) = lower(?) LIMIT 1").bind(newFactionName).first<{ id: number }>())?.id ?? null;
        if (!factionId) {
          const factionResult = await db.prepare("INSERT INTO factions (name, created_at) VALUES (?, ?)").bind(newFactionName, now).run();
          factionId = Number(factionResult.meta.last_row_id);
        }
      } else if (selectedFactionId > 0) {
        factionId = (await db.prepare("SELECT id FROM factions WHERE id = ?").bind(selectedFactionId).first<{ id: number }>())?.id ?? null;
      }
      if (!factionId) return Response.json({ error: "Selecione uma facção existente ou informe uma nova." }, { status: 400 });
    }
    const result = await db.prepare(`INSERT INTO people
      (full_name, nickname, cpf, birth_date, mother_name, city, state, status, notes, faction_id, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        fullName,
        nickname,
        cpf,
        cleanText(form.get("birthDate")),
        cleanText(form.get("motherName")),
        cleanText(form.get("city")),
        cleanText(form.get("state")),
        status,
        cleanText(form.get("notes")),
        factionId,
        operator,
        now,
        now,
      ).run();
    const id = Number(result.meta.last_row_id);
    createdId = id;

    const statements: D1PreparedStatement[] = [];
    for (const address of addresses) {
      if (!address.address?.trim()) continue;
      statements.push(db.prepare(`INSERT INTO addresses
        (person_id, label, address, city, state, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, address.label?.trim() || "Residencial", address.address.trim(), address.city?.trim() || null, address.state?.trim() || null, address.notes?.trim() || null, now));
    }
    for (const item of seizedObjects) {
      if (!item.description?.trim()) continue;
      statements.push(db.prepare(`INSERT INTO seized_objects
        (person_id, description, quantity, seized_at, location, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, item.description.trim(), Math.max(1, Number(item.quantity) || 1), item.seizedAt || null, item.location?.trim() || null, item.notes?.trim() || null, now));
    }
    if (source === "approach" && latitude && longitude) {
      statements.push(db.prepare(`INSERT INTO approaches
        (person_id, occurred_at, latitude, longitude, accuracy_meters, location_label, notes, operator_email, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          id,
          cleanText(form.get("approachDate")) || now,
          latitude,
          longitude,
          Number(cleanText(form.get("accuracyMeters"))) || null,
          cleanText(form.get("locationLabel")),
          cleanText(form.get("approachNotes")),
          operator,
          now,
        ));
    }
    statements.push(db.prepare("INSERT INTO audit_logs (operator_email, action, target_id, created_at) VALUES (?, 'CREATE_PERSON', ?, ?)").bind(operator, id, now));
    if (statements.length) await db.batch(statements);

    await saveMedia(id, "face", facePhotos, now, cleanText(form.get("facePhotoDate")), facePhotoHashes, faceEmbeddings);
    await saveMedia(id, "tattoo", tattoos, now, cleanText(form.get("tattooPhotoDate")), tattooHashes);

    const personRow = await db.prepare(`SELECT ${personColumns} FROM people WHERE id = ?`).bind(id).first<PersonRow>();
    return Response.json({ person: personRow ? await toPerson(personRow) : null }, { status: 201 });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : "";
    if (createdId) {
      const storedMedia = await db.prepare("SELECT object_key FROM person_media WHERE person_id = ?").bind(createdId).all<{ object_key: string }>();
      await Promise.all(storedMedia.results.map((item) => bucket().delete(item.object_key)));
      await db.batch([
        db.prepare("DELETE FROM person_media WHERE person_id = ?").bind(createdId),
        db.prepare("DELETE FROM seized_objects WHERE person_id = ?").bind(createdId),
        db.prepare("DELETE FROM approaches WHERE person_id = ?").bind(createdId),
        db.prepare("DELETE FROM addresses WHERE person_id = ?").bind(createdId),
        db.prepare("DELETE FROM audit_logs WHERE target_id = ? AND action = 'CREATE_PERSON'").bind(createdId),
        db.prepare("DELETE FROM people WHERE id = ?").bind(createdId),
      ]);
    }
    const message = rawMessage.includes("UNIQUE")
      ? "Já existe um cadastro com este CPF."
      : rawMessage === "MEDIA_INVALID"
        ? "Use imagens JPG, PNG ou WEBP de até 5 MB cada."
        : "Não foi possível salvar o cadastro.";
    return Response.json({ error: message }, { status: rawMessage.includes("UNIQUE") ? 409 : 400 });
  }
}

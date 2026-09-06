import { requireSession, storageWritesEnabled } from "../../../auth";

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

function cleanText(value: FormDataEntryValue | null) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

function validateMedia(files: File[]) {
  const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
  if (files.some((file) => file.size && (!allowedTypes.has(file.type) || file.size > 5 * 1024 * 1024))) {
    throw new Error("MEDIA_INVALID");
  }
}

async function hashFile(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function ensureVisualHashColumn() {
  const columns = await database().prepare("PRAGMA table_info(person_media)").all<{ name: string }>();
  if (!columns.results.some((column) => column.name === "visual_hash")) await database().prepare("ALTER TABLE person_media ADD COLUMN visual_hash TEXT").run();
  const refreshedColumns = await database().prepare("PRAGMA table_info(person_media)").all<{ name: string }>();
  if (!refreshedColumns.results.some((column) => column.name === "face_embedding")) await database().prepare("ALTER TABLE person_media ADD COLUMN face_embedding TEXT").run();
}

async function saveMedia(personId: number, kind: "face" | "tattoo", files: File[], now: string, capturedAt: string | null, visualHashes: string[] = [], faceEmbeddings: Array<number[] | null> = []) {
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
    await db
      .prepare(`INSERT INTO person_media
        (person_id, kind, object_key, original_name, content_type, sha256, visual_hash, face_embedding, captured_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(personId, kind, objectKey, file.name, file.type, sha256, visualHashes[index] || null, faceEmbeddings[index]?.length === 128 ? JSON.stringify(faceEmbeddings[index]) : null, capturedAt, now)
      .run();
  }
}

async function toPerson(row: PersonRow) {
  const db = database();
  const [addresses, approaches, seizedObjects, media] = await Promise.all([
    db.prepare("SELECT id, label, address, city, state, notes FROM addresses WHERE person_id = ? ORDER BY id DESC").bind(row.id).all(),
    db.prepare("SELECT id, occurred_at AS occurredAt, latitude, longitude, accuracy_meters AS accuracyMeters, location_label AS locationLabel, notes FROM approaches WHERE person_id = ? ORDER BY occurred_at DESC").bind(row.id).all(),
    db.prepare("SELECT id, description, quantity, seized_at AS seizedAt, location, notes FROM seized_objects WHERE person_id = ? ORDER BY seized_at DESC, id DESC").bind(row.id).all(),
    db.prepare("SELECT id, kind, original_name AS originalName, description, captured_at AS capturedAt FROM person_media WHERE person_id = ? ORDER BY COALESCE(captured_at, created_at) DESC, id DESC").bind(row.id).all<{ id: number; kind: "face" | "face_front" | "face_profile" | "tattoo"; originalName: string; description: string | null; capturedAt: string | null }>(),
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

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Acesso não autenticado." }, { status: 401 });
  const operator = session.email;

  const { id } = await context.params;
  const personId = Number(id);
  if (!Number.isInteger(personId) || personId < 1) {
    return Response.json({ error: "Cadastro inválido." }, { status: 400 });
  }

  const db = database();
  const current = await db.prepare("SELECT id FROM people WHERE id = ?").bind(personId).first();
  if (!current) return Response.json({ error: "Cadastro não encontrado." }, { status: 404 });

  const form = await request.formData();
  await ensureVisualHashColumn();
  const fullName = cleanText(form.get("fullName")) ?? "";
  const cpf = (cleanText(form.get("cpf")) ?? "").replace(/\D/g, "");
  if (fullName.length < 3) return Response.json({ error: "Informe o nome completo." }, { status: 400 });
  if (cpf.length !== 11) return Response.json({ error: "Informe um CPF com 11 dígitos." }, { status: 400 });

  const statusValue = cleanText(form.get("status"));
  const status: Status =
    statusValue === "verified" || statusValue === "attention" ? statusValue : "review";
  const addresses = parseJsonArray<AddressInput>(form.get("addresses"));
  const seizedObjects = parseJsonArray<SeizedObjectInput>(form.get("seizedObjects"));
  const facePhotos = form.getAll("facePhotos").filter((item): item is File => item instanceof File && item.size > 0);
  const tattoos = form.getAll("tattoos").filter((item): item is File => item instanceof File && item.size > 0);
  const facePhotoHashes = parseJsonArray<string>(form.get("facePhotoHashes"));
  const tattooHashes = parseJsonArray<string>(form.get("tattooHashes"));
  const faceEmbeddings = parseJsonArray<number[]>(form.get("faceEmbeddings"));
  const removeMediaIds = parseJsonArray<number>(form.get("removeMediaIds")).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0);
  const mediaFiles = [...facePhotos, ...tattoos];
  if (facePhotos.length && !cleanText(form.get("facePhotoDate"))) {
    return Response.json({ error: "Informe a data das novas fotos do rosto." }, { status: 400 });
  }
  if (tattoos.length && !cleanText(form.get("tattooPhotoDate"))) {
    return Response.json({ error: "Informe a data das novas fotos de tatuagens." }, { status: 400 });
  }

  try {
    validateMedia(mediaFiles);
  } catch {
    return Response.json({ error: "Use imagens JPG, PNG ou WEBP de até 5 MB cada." }, { status: 400 });
  }

  const now = new Date().toISOString();
  try {
    const mediaToRemove = removeMediaIds.length
      ? await db.prepare(`SELECT id, object_key FROM person_media WHERE person_id = ? AND id IN (${removeMediaIds.map(() => "?").join(",")})`).bind(personId, ...removeMediaIds).all<{ id: number; object_key: string }>()
      : { results: [] as { id: number; object_key: string }[] };
    for (const item of mediaToRemove.results ?? []) await bucket().delete(item.object_key);
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
    const statements: D1PreparedStatement[] = [
      db.prepare(`UPDATE people SET
        full_name = ?, nickname = ?, cpf = ?, birth_date = ?, mother_name = ?,
        city = ?, state = ?, status = ?, notes = ?, faction_id = ?, updated_at = ?
        WHERE id = ?`)
        .bind(
          fullName,
          cleanText(form.get("nickname")),
          cpf,
          cleanText(form.get("birthDate")),
          cleanText(form.get("motherName")),
          cleanText(form.get("city")),
          cleanText(form.get("state")),
          status,
          cleanText(form.get("notes")),
          factionId,
          now,
          personId,
        ),
      db.prepare("DELETE FROM addresses WHERE person_id = ?").bind(personId),
      db.prepare("DELETE FROM seized_objects WHERE person_id = ?").bind(personId),
    ];

    for (const address of addresses) {
      if (!address.address?.trim()) continue;
      statements.push(
        db.prepare(`INSERT INTO addresses
          (person_id, label, address, city, state, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .bind(
            personId,
            address.label?.trim() || "Residencial",
            address.address.trim(),
            address.city?.trim() || null,
            address.state?.trim().toUpperCase() || null,
            address.notes?.trim() || null,
            now,
          ),
      );
    }
    for (const item of seizedObjects) {
      if (!item.description?.trim()) continue;
      statements.push(
        db.prepare(`INSERT INTO seized_objects
          (person_id, description, quantity, seized_at, location, notes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .bind(
            personId,
            item.description.trim(),
            Math.max(1, Number(item.quantity) || 1),
            item.seizedAt || null,
            item.location?.trim() || null,
            item.notes?.trim() || null,
            now,
          ),
      );
    }
    statements.push(
      db.prepare("INSERT INTO audit_logs (operator_email, action, target_id, query, created_at) VALUES (?, 'UPDATE_PERSON', ?, ?, ?)")
        .bind(operator, personId, "identification,addresses,seized_objects,media", now),
    );
    if (mediaToRemove.results?.length) {
      statements.push(db.prepare(`DELETE FROM person_media WHERE person_id = ? AND id IN (${mediaToRemove.results.map(() => "?").join(",")})`).bind(personId, ...mediaToRemove.results.map((item) => item.id)));
    }
    await db.batch(statements);

    await saveMedia(personId, "face", facePhotos, now, cleanText(form.get("facePhotoDate")), facePhotoHashes, faceEmbeddings);
    await saveMedia(personId, "tattoo", tattoos, now, cleanText(form.get("tattooPhotoDate")), tattooHashes);

    const row = await db.prepare(`SELECT ${personColumns} FROM people WHERE id = ?`).bind(personId).first<PersonRow>();
    return Response.json({ person: row ? await toPerson(row) : null });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : "";
    const duplicateCpf = rawMessage.includes("UNIQUE");
    return Response.json(
      { error: duplicateCpf ? "Já existe outro cadastro com este CPF." : "Não foi possível atualizar o cadastro." },
      { status: duplicateCpf ? 409 : 400 },
    );
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return Response.json({ error: "Acesso não autenticado." }, { status: 401 });
  const operator = session.email;
  const { id } = await context.params;
  const personId = Number(id);
  if (!Number.isInteger(personId) || personId < 1) return Response.json({ error: "Cadastro inválido." }, { status: 400 });
  const db = database();
  const person = await db.prepare("SELECT full_name, cpf FROM people WHERE id = ?").bind(personId).first<{ full_name: string; cpf: string }>();
  if (!person) return Response.json({ error: "Cadastro não encontrado." }, { status: 404 });
  const media = await db.prepare("SELECT object_key FROM person_media WHERE person_id = ?").bind(personId).all<{ object_key: string }>();
  await Promise.all(media.results.map((item) => bucket().delete(item.object_key)));
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("DELETE FROM person_media WHERE person_id = ?").bind(personId),
    db.prepare("DELETE FROM seized_objects WHERE person_id = ?").bind(personId),
    db.prepare("DELETE FROM approaches WHERE person_id = ?").bind(personId),
    db.prepare("DELETE FROM addresses WHERE person_id = ?").bind(personId),
    db.prepare("DELETE FROM people WHERE id = ?").bind(personId),
    db.prepare("INSERT INTO audit_logs (operator_email, action, target_id, query, created_at) VALUES (?, 'DELETE_PERSON', ?, ?, ?)")
      .bind(operator, personId, `${person.full_name}|cpf-final:${person.cpf.slice(-4)}`, now),
  ]);
  return Response.json({ deleted: true });
}

"use client";

import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { ALERT_CATEGORIES, ALERT_PRIORITY_LABEL, ALERT_PRIORITY_ORDER, type AlertPriority } from "./alert-categories";
import { LOCALITIES, LOCALITY_CITIES, LOCALITY_STATES } from "./localities";
import { apiFetch } from "./api-client";

type Operator = { id: string; name: string; warName: string; rank: string; email: string; role: "admin" | "operator"; invitedBy: string | null };
type InviteLink = { id: number; code: string; expiresAt: string; link: string; kind: "single" | "bulk"; revokedAt?: string | null; useCount?: number };
type Status = "alive" | "dead";
type CustodyStatus = "free" | "detained";
type Address = { id?: number; label: string; address: string; city: string; state: string; notes: string };
type Faction = { id: number; name: string };
type SeizedObject = { id?: number; description: string; quantity?: number; seizedAt: string; location?: string; notes?: string };
type Approach = { id: number; occurredAt: string; latitude: string; longitude: string; accuracyMeters: number | null; locationLabel: string | null; notes: string | null };
type Media = { id: number; kind: "face" | "face_front" | "face_profile" | "tattoo"; originalName: string; description: string | null; capturedAt: string | null; url: string };
type Person = {
  id: number;
  fullName: string;
  nickname: string | null;
  cpf: string;
  birthDate: string | null;
  motherName: string | null;
  city: string | null;
  state: string | null;
  status: Status;
  custodyStatus: CustodyStatus;
  notes: string | null;
  factionId: number | null;
  factionName: string | null;
  createdAt: string;
  addresses: Address[];
  approaches: Approach[];
  approachCount: number;
  seizedObjects: SeizedObject[];
  media: Media[];
};

type GeoPoint = { latitude: string; longitude: string; accuracyMeters: string };
type View = "search" | "register" | "account" | "operators" | "records" | "alerts";
type SearchMode = "text" | "face" | "tattoo";
type RegisterNotice = { kind: "success" | "error"; text: string };

// Keep image-based searches unavailable until they are explicitly reviewed
// and re-enabled. Photos used in records remain unaffected.
const IMAGE_SEARCH_ENABLED = false;

const statusLabel: Record<Status, string> = {
  alive: "Vivo",
  dead: "Morto",
};

const custodyStatusLabel: Record<CustodyStatus, string> = {
  free: "Em liberdade",
  detained: "Preso",
};

const mediaLabel = {
  face: "Foto do rosto",
  face_front: "Foto do rosto",
  face_profile: "Foto do rosto",
  tattoo: "Tatuagem",
};

const blankAddress = (): Address => ({ label: "Residencial", address: "", city: "", state: "PB", notes: "" });
const BRASILIA_TIME_ZONE = "America/Sao_Paulo";

type AlertImage = { id: number; name: string; type: string; createdAt: string; url: string };
type AlertRecord = {
  id: number;
  categoryKey: string;
  categoryLabel: string;
  priority: AlertPriority;
  municipality: string;
  municipalityState: "PB" | "RN" | null;
  neighborhood: string | null;
  peopleInfo: string | null;
  vehicleInfo: string | null;
  description: string;
  occurredAt: string;
  locationLink: string | null;
  latitude: string | null;
  longitude: string | null;
  accuracyMeters: number | null;
  status: "open" | "resolved";
  createdBy: string;
  createdByName: string;
  createdAt: string;
  resolvedBy: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  images: AlertImage[];
};

function brasiliaNowParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BRASILIA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function currentBrasiliaDate() {
  const { year, month, day } = brasiliaNowParts();
  return `${year}-${month}-${day}`;
}

function currentBrasiliaDateTime() {
  const { year, month, day, hour, minute } = brasiliaNowParts();
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (error) => { window.clearTimeout(timer); reject(error); },
    );
  });
}

async function compressImage(file: File, targetBytes: number) {
  if (file.size <= targetBytes && file.type === "image/webp") return file;
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("IMAGE_DECODE_FAILED"));
      element.src = sourceUrl;
    });
    // Keep enough detail for facial review while avoiding multi-megabyte phone photos.
    let maxDimension = 960;
    let outputType: "image/webp" | "image/jpeg" = "image/webp";
    let blob: Blob | null = null;
    const encode = (canvas: HTMLCanvasElement, quality: number) => new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, outputType, quality);
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) return file;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      let quality = 0.5;
      blob = await encode(canvas, quality);
      if (outputType === "image/webp" && blob?.type !== "image/webp") {
        outputType = "image/jpeg";
        blob = await encode(canvas, quality);
      }
      while (blob && blob.size > targetBytes && quality > 0.08) {
        quality -= 0.06;
        blob = await encode(canvas, quality);
      }
      if (blob && blob.size <= targetBytes) break;
      maxDimension = Math.round(maxDimension * 0.78);
    }
    if (!blob || blob.size >= file.size) return file;
    const baseName = file.name.replace(/\.[^.]+$/, "") || "imagem";
    const extension = outputType === "image/webp" ? "webp" : "jpg";
    return new File([blob], `${baseName}.${extension}`, { type: outputType, lastModified: Date.now() });
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

function encodeBits(values: number[], compare: (index: number) => boolean) {
  let hash = "";
  for (let index = 0; index < values.length; index += 4) {
    let nibble = 0;
    for (let bit = 0; bit < 4; bit += 1) {
      const valueIndex = index + bit;
      if (valueIndex < values.length && compare(valueIndex)) nibble |= 1 << (3 - bit);
    }
    hash += nibble.toString(16);
  }
  return hash;
}

function grayscaleSamples(image: HTMLImageElement, size: number, crop: boolean) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;

  if (crop) {
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    const offsetX = (image.naturalWidth - side) / 2;
    const offsetY = (image.naturalHeight - side) / 2;
    context.drawImage(image, offsetX, offsetY, side, side, 0, 0, size, size);
  } else {
    context.drawImage(image, 0, 0, size, size);
  }

  const pixels = context.getImageData(0, 0, size, size).data;
  const luminance: number[] = [];
  for (let index = 0; index < pixels.length; index += 4) {
    luminance.push((pixels[index] * 299 + pixels[index + 1] * 587 + pixels[index + 2] * 114) / 1000);
  }
  return luminance;
}

function averageHash(values: number[]) {
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return encodeBits(values, (index) => values[index] >= average);
}

function differenceHash(values: number[], size: number) {
  const differences: number[] = [];
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size - 1; column += 1) {
      const index = row * size + column;
      differences.push(values[index] >= values[index + 1] ? 1 : 0);
    }
  }
  return encodeBits(differences, (index) => differences[index] === 1);
}

async function visualSignature(file: File) {
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("IMAGE_DECODE_FAILED"));
      element.src = sourceUrl;
    });
    const legacy = grayscaleSamples(image, 8, false);
    const fit = grayscaleSamples(image, 16, false);
    const crop = grayscaleSamples(image, 16, true);
    if (!legacy || !fit || !crop) return "";
    return ["v2", averageHash(legacy), averageHash(fit), differenceHash(fit, 16), averageHash(crop), differenceHash(crop, 16)].join("|");
  } finally { URL.revokeObjectURL(sourceUrl); }
}

async function safeVisualSignature(file: File) {
  try { return await visualSignature(file); } catch { return ""; }
}

const blankObject = (): SeizedObject => ({ description: "", seizedAt: currentBrasiliaDate() });
const blankRegisterDraft = () => ({ fullName: "", cpf: "", birthDate: "", motherName: "", city: "", state: "PB", notes: "" });

function initials(name: string) {
  return name.split(" ").filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function rankLabel(rank: string | null | undefined) { const value = (rank ?? "").trim(); const normalized = value.toLowerCase(); const map: Record<string,string> = {"aluno soldado":"AL SD","soldado":"SD","cabo":"CB","3º sargento":"3º SGT","3o sargento":"3º SGT","2º sargento":"2º SGT","2o sargento":"2º SGT","1º sargento":"1º SGT","1o sargento":"1º SGT","subtenente":"ST","cadete":"CAD","aspirante a oficial":"ASP OF","2º tenente":"2º TEN","1º tenente":"1º TEN","capitão":"CAP","major":"MAJ","tenente-coronel":"TEN CEL","coronel":"CEL"}; return map[normalized] ?? value; }

function maskCpf(cpf: string) {
  const digits = cpf.replace(/\D/g, "");
  if (digits.length !== 11) return cpf;
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Não informada";
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const hasTimeZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  const hasMinutePrecision = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value);
  const normalized = dateOnly ? `${value}T12:00:00-03:00` : hasTimeZone ? value : hasMinutePrecision ? `${value}:00-03:00` : `${value}-03:00`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("pt-BR", {
    timeZone: BRASILIA_TIME_ZONE,
    dateStyle: "short",
    timeStyle: dateOnly ? undefined : "short",
  }).format(date);
}

function normalizeSearch(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

type FaceApiModule = typeof import("@vladmandic/face-api");
let faceModelsPromise: Promise<FaceApiModule> | null = null;

// GitHub Pages serves SICC under /SICC/. Resolve model files from the Vite
// base path instead of the domain root, otherwise face detection fails.
function faceModelPath() {
  const base = String(import.meta.env.BASE_URL || "/").replace(/\/?$/, "/");
  return `${base}models/face-api`;
}

async function ensureFaceModels() {
  if (!faceModelsPromise) {
    faceModelsPromise = import("@vladmandic/face-api").then(async (faceapi) => {
      const modelPath = faceModelPath();
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(modelPath),
        faceapi.nets.faceLandmark68TinyNet.loadFromUri(modelPath),
        faceapi.nets.faceRecognitionNet.loadFromUri(modelPath),
      ]);
      return faceapi;
    }).catch((error) => {
      faceModelsPromise = null;
      throw error;
    });
  }
  return faceModelsPromise;
}

async function faceEmbedding(file: File) {
  const faceapi = await ensureFaceModels();
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("IMAGE_DECODE_FAILED"));
      element.src = sourceUrl;
    });
    const detections = await faceapi
      .detectAllFaces(image, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.45 }))
      .withFaceLandmarks(true)
      .withFaceDescriptors();
    if (!detections.length) return null;
    const largest = detections.reduce((current, candidate) => {
      const currentArea = current.detection.box.width * current.detection.box.height;
      const candidateArea = candidate.detection.box.width * candidate.detection.box.height;
      return candidateArea > currentArea ? candidate : current;
    });
    return Array.from(largest.descriptor);
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

async function safeFaceEmbedding(file: File) {
  try { return await faceEmbedding(file); } catch { return null; }
}

async function reindexMissingFaceEmbeddings() {
  const response = await apiFetch("/api/face-index");
  if (!response.ok) return;
  const data = await response.json() as { media?: Array<{ id: number; url: string; originalName: string }> };
  const updates: Array<{ mediaId: number; embedding: number[] }> = [];
  for (const media of data.media ?? []) {
    const imageResponse = await apiFetch(media.url);
    if (!imageResponse.ok) continue;
    const blob = await imageResponse.blob();
    const file = new File([blob], media.originalName || `face-${media.id}.jpg`, { type: blob.type || "image/jpeg" });
    const embedding = await safeFaceEmbedding(file);
    if (embedding) updates.push({ mediaId: media.id, embedding });
  }
  if (!updates.length) return;
  await apiFetch("/api/face-index", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ updates }),
  });
}

export default function SICCApp({ operator, onLogout }: { operator: Operator; onLogout: () => Promise<void> }) {
  const [view, setView] = useState<View>("search");
  const [searchMode, setSearchMode] = useState<SearchMode>("text");
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [registerDraft, setRegisterDraft] = useState(blankRegisterDraft);
  const [results, setResults] = useState<Person[]>([]);
  const [selected, setSelected] = useState<Person | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [registerNotice, setRegisterNotice] = useState<RegisterNotice | null>(null);
  const registerFormRef = useRef<HTMLFormElement | null>(null);
  const [source, setSource] = useState<"administrative" | "approach">("administrative");
  const [location, setLocation] = useState<GeoPoint | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([blankAddress()]);
  const [seizedObjects, setSeizedObjects] = useState<SeizedObject[]>([]);
  const [approachPerson, setApproachPerson] = useState<Person | null>(null);
  const [approachLocation, setApproachLocation] = useState<GeoPoint | null>(null);
  const [editPerson, setEditPerson] = useState<Person | null>(null);
  const [factions, setFactions] = useState<Faction[]>([]);
  const [factionAffiliated, setFactionAffiliated] = useState(false);
  const [factionChoice, setFactionChoice] = useState("");
  const [newFactionName, setNewFactionName] = useState("");
  const [invite, setInvite] = useState<InviteLink | null>(null);
  const [inviteCopyStatus, setInviteCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const [inviteGenerating, setInviteGenerating] = useState(false);
  const [bulkInvite, setBulkInvite] = useState<InviteLink | null>(null);
  const [bulkInviteCopyStatus, setBulkInviteCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const [bulkInviteGenerating, setBulkInviteGenerating] = useState(false);
  const [bulkInviteConfirm, setBulkInviteConfirm] = useState(false);
  const [activeInvites, setActiveInvites] = useState<InviteLink[]>([]);
  const [totalPeopleCount, setTotalPeopleCount] = useState<number | null>(null);
  const [logoutConfirm, setLogoutConfirm] = useState(false);

  const inviteStorageKey = `sicc:invite-links:${operator.id}`;

  function readStoredInvites() {
    try {
      const raw = window.localStorage.getItem(inviteStorageKey);
      const parsed = raw ? JSON.parse(raw) as unknown : [];
      if (!Array.isArray(parsed)) return [] as InviteLink[];
      return parsed.filter((item): item is InviteLink => Boolean(item && typeof item === "object" && typeof (item as InviteLink).id === "number" && typeof (item as InviteLink).code === "string" && typeof (item as InviteLink).link === "string" && typeof (item as InviteLink).expiresAt === "string" && ((item as InviteLink).kind === "single" || (item as InviteLink).kind === "bulk")));
    } catch {
      return [] as InviteLink[];
    }
  }

  function writeStoredInvites(items: InviteLink[]) {
    try {
      if (items.length) window.localStorage.setItem(inviteStorageKey, JSON.stringify(items));
      else window.localStorage.removeItem(inviteStorageKey);
    } catch {
      // O armazenamento local pode estar bloqueado pelo navegador; a sessão continua funcionando.
    }
  }

  async function refreshStoredInvites() {
    const appPath = window.location.pathname.endsWith("/") ? window.location.pathname : `${window.location.pathname}/`;
    const buildLink = (code: string) => {
      const url = new URL(appPath, window.location.origin);
      url.searchParams.set("convite", code);
      return url.toString();
    };
    const stored = readStoredInvites().filter((item) => {
      const expiry = new Date(item.expiresAt).getTime();
      return Number.isFinite(expiry) && expiry > Date.now();
    });
    let remote: InviteLink[] = [];
    try {
      const response = await apiFetch("/api/invites", { cache: "no-store" });
      const data = await response.json() as { invites?: Array<Partial<InviteLink> & { code?: string }> };
      if (response.ok) {
        remote = (data.invites ?? []).filter((item): item is InviteLink => Boolean(item.id && item.code && item.expiresAt && (item.kind === "single" || item.kind === "bulk"))).map((item) => ({ ...item, link: buildLink(item.code) }));
      }
    } catch {
      // Mantém os convites locais quando a consulta de atualização estiver indisponível.
    }
    const localChecked = await Promise.all(stored.map(async (item) => {
      try {
        const response = await apiFetch(`/api/invites?code=${encodeURIComponent(item.code)}`, { cache: "no-store" });
        const data = await response.json() as { active?: boolean; invite?: Partial<InviteLink> | null };
        if (!response.ok || !data.active) return null;
        return { ...item, ...(data.invite ?? {}), link: buildLink(item.code) };
      } catch {
        return item;
      }
    }));
    const byId = new Map<number, InviteLink>();
    [...localChecked.filter((item): item is InviteLink => Boolean(item)), ...remote].forEach((item) => byId.set(item.id, item));
    const active = [...byId.values()];
    writeStoredInvites(active);
    setActiveInvites(active);
    setInvite(active.filter((item) => item.kind === "single").sort((a, b) => b.id - a.id)[0] ?? null);
    setBulkInvite(active.filter((item) => item.kind === "bulk").sort((a, b) => b.id - a.id)[0] ?? null);
  }

  useEffect(() => {
    let active = true;
    const refresh = () => { if (active) void refreshStoredInvites(); };
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [operator.id]);

  useEffect(() => {
    let active = true;
    void apiFetch("/api/people?count=1", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as { total?: number };
        if (active && response.ok) setTotalPeopleCount(Number(data.total ?? 0));
      })
      .catch(() => {});
    return () => { active = false; };
  }, [operator.id]);

  const firstName = operator.name.split(" ")[0] || "Operador";
  const title = view === "register" ? "Novo cadastro" : view === "account" ? "Minha conta" : view === "operators" ? "Operadores" : view === "records" ? "Cadastros" : view === "alerts" ? "Alertas operacionais" : "Consulta de pessoas";

  function showRegisterNotice(kind: RegisterNotice["kind"], text: string) {
    setMessage(text);
    setRegisterNotice({ kind, text });
    if (kind === "error") {
      window.requestAnimationFrame(() => registerFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  }

  function closeRegisterNotice() {
    const wasError = registerNotice?.kind === "error";
    setRegisterNotice(null);
    if (wasError) window.setTimeout(() => registerFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  function navigate(next: View) {
    if (next === "register") {
      setRegisterDraft(blankRegisterDraft());
      setFactionAffiliated(false);
      setFactionChoice("");
      setNewFactionName("");
      void loadFactions();
    }
    setView(next);
    setMessage("");
  }

  async function loadFactions() {
    const response = await apiFetch("/api/factions");
    if (!response.ok) return;
    const data = await response.json() as { factions?: Faction[] };
    setFactions(data.factions ?? []);
  }

  async function createInvite(kind: "single" | "bulk" = "single") {
    setLoading(true);
    if (kind === "bulk") setBulkInviteGenerating(true);
    else setInviteGenerating(true);
    setMessage("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await apiFetch("/api/invites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind }), signal: controller.signal, cache: "no-store" });
      let data: { id?: number; code?: string; expiresAt?: string; kind?: "single" | "bulk"; error?: string } = {};
      try { data = await response.json() as typeof data; } catch { /* resposta não JSON */ }
      if (!response.ok || !data.id || !data.code || !data.expiresAt) {
        setMessage(data.error ?? "Não foi possível gerar o link de convite.");
        return;
      }
      // GitHub Pages publica o app em /SICC/. Usar apenas a origem gera um
      // link para 4quarenta.github.io/, que não contém esta aplicação e retorna 404.
      const appPath = window.location.pathname.endsWith("/") ? window.location.pathname : `${window.location.pathname}/`;
      const inviteUrl = new URL(appPath, window.location.origin);
      inviteUrl.searchParams.set("convite", data.code);
      const generated: InviteLink = { id: data.id, code: data.code, expiresAt: data.expiresAt, link: inviteUrl.toString(), kind: data.kind ?? kind };
      const stored = readStoredInvites().filter((item) => item.id !== generated.id);
      writeStoredInvites([...stored, generated]);
      setActiveInvites((current) => [...current.filter((item) => item.id !== generated.id), generated].sort((a, b) => b.id - a.id));
      if (kind === "bulk") { setBulkInvite(generated); setBulkInviteCopyStatus("idle"); }
      else { setInvite(generated); setInviteCopyStatus("idle"); }
    } catch (error) {
      setMessage(error instanceof DOMException && error.name === "AbortError" ? "A geração do convite demorou demais. Tente novamente." : "Não foi possível gerar o link de convite.");
    } finally {
      window.clearTimeout(timeout);
      setLoading(false);
      if (kind === "bulk") setBulkInviteGenerating(false);
      else setInviteGenerating(false);
    }
  }
  async function copyInviteLink(target: "single" | "bulk" = "single") {
    const selectedInvite = target === "bulk" ? bulkInvite : invite;
    if (!selectedInvite) return;
    try {
      await navigator.clipboard.writeText(selectedInvite.link);
      if (target === "bulk") { setBulkInviteCopyStatus("copied"); window.setTimeout(() => setBulkInviteCopyStatus("idle"), 2500); }
      else { setInviteCopyStatus("copied"); window.setTimeout(() => setInviteCopyStatus("idle"), 2500); }
    } catch {
      if (target === "bulk") setBulkInviteCopyStatus("error");
      else setInviteCopyStatus("error");
    }
  }

  async function copySpecificInvite(selectedInvite: InviteLink) {
    try {
      await navigator.clipboard.writeText(selectedInvite.link);
      setMessage("Link copiado.");
    } catch {
      setMessage("Não foi possível copiar. Selecione o link manualmente.");
    }
  }

  async function revokeBulkInvite() {
    if (!bulkInvite) return;
    setLoading(true);
    try {
      const response = await apiFetch(`/api/invites/${bulkInvite.id}`, { method: "PATCH" });
      const data = await response.json() as { error?: string };
      if (!response.ok) { setMessage(data.error ?? "Não foi possível revogar o link."); return; }
      const revokedAt = new Date().toISOString();
      setBulkInvite((current) => current ? { ...current, revokedAt } : current);
      writeStoredInvites(readStoredInvites().map((item) => item.id === bulkInvite.id ? { ...item, revokedAt } : item));
      setMessage("Link reutilizável revogado.");
    } catch {
      setMessage("Não foi possível revogar o link. Verifique sua conexão.");
    } finally { setLoading(false); }
  }
  async function search(event?: FormEvent) {
    event?.preventDefault();
    const clean = query.trim();
    if (clean.length < 3) {
      setMessage("Digite pelo menos 3 caracteres, uma alcunha ou um CPF.");
      return;
    }
    setLoading(true);
    setMessage("");
    setSubmittedQuery("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await apiFetch(`/api/people?q=${encodeURIComponent(clean)}`, { signal: controller.signal, cache: "no-store" });
      let data: { people?: Person[]; total?: number; error?: string } = {};
      try { data = await response.json() as { people?: Person[]; total?: number; error?: string }; } catch { /* resposta não JSON do servidor */ }
      if (!response.ok) {
        setMessage(data.error ?? "Não foi possível realizar a consulta.");
        return;
      }
      const localPeople = data.people ?? [];
      if (typeof data.total === "number") setTotalPeopleCount(data.total);
      setSubmittedQuery(clean);
      setResults(localPeople);
      setView("search");
      if (!localPeople.length) setMessage("Nenhuma pessoa localizada no banco do SICC.");
    } catch (error) {
      setMessage(error instanceof DOMException && error.name === "AbortError" ? "A consulta demorou demais. Tente novamente." : "Não foi possível realizar a consulta. Verifique sua conexão.");
    } finally {
      window.clearTimeout(timeout);
      setLoading(false);
    }
  }

  function registerFromSearch() {
    const clean = query.trim();
    const cpfDigits = clean.replace(/\D/g, "");
    setRegisterDraft({ ...blankRegisterDraft(), ...(cpfDigits.length === 11 ? { cpf: cpfDigits } : { fullName: clean }) });
    void loadFactions();
    setMessage("");
    setView("register");
  }

  async function pasteFromInfoseg() {
    setMessage("");
    if (!navigator.clipboard?.readText) {
      setMessage("Este navegador não permite ler a área de transferência. Cole os dados manualmente nos campos.");
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setMessage("A área de transferência está vazia.");
        return;
      }
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const cpfIndex = lines.findIndex((line) => line.replace(/\D/g, "").length === 11);
      const dateIndex = lines.findIndex((line) => /^\d{2}\/\d{2}\/\d{4}$/.test(line));
      const addressIndex = lines.findIndex((line) => /^(rua|r\.|avenida|av\.|travessa|tv\.|rodovia|sítio|sitio|fazenda|praça|praca)\b/i.test(line));
      const cityStateIndex = lines.findIndex((line) => /^.+\s+-\s+[A-Z]{2}$/i.test(line));
      const cityState = cityStateIndex >= 0 ? lines[cityStateIndex].match(/^(.+?)\s+-\s+([A-Z]{2})$/i) : null;
      const dateParts = dateIndex >= 0 ? lines[dateIndex].match(/^(\d{2})\/(\d{2})\/(\d{4})$/) : null;
      const fullName = cpfIndex > 0 ? lines[0] : "";
      const motherName = cpfIndex > 1 ? lines[1] : "";
      const cpf = cpfIndex >= 0 ? lines[cpfIndex].replace(/\D/g, "") : "";
      const structuralIndexes = new Set([0, 1, cpfIndex, dateIndex, addressIndex, cityStateIndex].filter((index) => index >= 0));
      const notes = lines
        .filter((_, index) => !structuralIndexes.has(index))
        .map((line) => line.replace(/^obs(?:ervaç(?:ão|ao))?\s*:\s*/i, "").trim())
        .filter(Boolean)
        .join("\n");
      const address = addressIndex >= 0 ? lines[addressIndex] : "";

      setRegisterDraft({
        fullName,
        motherName,
        cpf,
        birthDate: dateParts ? `${dateParts[3]}-${dateParts[2]}-${dateParts[1]}` : "",
        city: cityState?.[1]?.trim() ?? "",
        state: cityState?.[2]?.toUpperCase() ?? "PB",
        notes,
      });
      setAddresses(address ? [{ ...blankAddress(), address, city: cityState?.[1]?.trim() ?? "", state: cityState?.[2]?.toUpperCase() ?? "PB" }] : [blankAddress()]);
      const recognized = [fullName, motherName, cpf, dateParts, address, cityState, notes].filter(Boolean).length;
      setMessage(recognized >= 4 ? "Dados do Infoseg preenchidos, incluindo as linhas adicionais em observações. Revise todos os campos antes de salvar." : "O texto foi lido, mas poucos campos foram reconhecidos. Revise e complete o cadastro manualmente.");
    } catch {
      setMessage("Não foi possível ler a área de transferência. Autorize o acesso e tente novamente.");
    }
  }

  async function searchImage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    setQuery("");
    if (searchMode !== "text" && !IMAGE_SEARCH_ENABLED) {
      setLoading(false);
      setMessage("As buscas por imagem estão desabilitadas.");
      return;
    }
    const form = new FormData(event.currentTarget);
    form.set("mode", searchMode);
    const image = form.get("image");
    if (!(image instanceof File) || !image.size) {
      setLoading(false);
      setMessage("Selecione uma imagem para consulta.");
      return;
    }
    try {
      if (searchMode === "face") {
        const embedding = await safeFaceEmbedding(image);
        if (!embedding) {
          setMessage("Não foi detectado um rosto nítido na imagem. Use uma foto frontal ou de perfil, com apenas uma pessoa visível.");
          return;
        }
        form.set("faceEmbedding", JSON.stringify(embedding));
        await reindexMissingFaceEmbeddings();
      } else {
        const signature = await safeVisualSignature(image);
        if (!signature) {
          setMessage("Não foi possível analisar esta imagem. Use JPG, PNG ou WEBP e tente novamente.");
          return;
        }
        form.set("visualHash", signature);
      }
      const response = await apiFetch("/api/search-image", { method: "POST", body: form });
      const data = (await response.json()) as { personIds?: number[]; notice?: string; error?: string };
      if (!response.ok) {
        setMessage(data.error ?? "Não foi possível analisar a imagem.");
        return;
      }
      const people = await Promise.all((data.personIds ?? []).map(async (id) => {
        const result = await apiFetch(`/api/people?id=${id}`);
        const payload = (await result.json()) as { people?: Person[] };
        return payload.people?.[0] ?? null;
      }));
      setResults(people.filter((person): person is Person => Boolean(person)));
      setView("search");
      setMessage(data.notice ?? "Consulta concluída.");
    } catch {
      setMessage("Não foi possível concluir a busca por imagem. Verifique a conexão e tente novamente.");
    } finally {
      setLoading(false);
    }
  }

  async function captureLocation(setter: (point: GeoPoint) => void) {
    setMessage("");
    if (!navigator.geolocation) {
      setMessage("Este dispositivo não disponibiliza geolocalização.");
      return;
    }
    setLoading(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setter({
          latitude: position.coords.latitude.toFixed(7),
          longitude: position.coords.longitude.toFixed(7),
          accuracyMeters: Math.round(position.coords.accuracy).toString(),
        });
        setLoading(false);
      },
      () => {
        setMessage("Não foi possível obter a localização. Verifique a permissão do navegador.");
        setLoading(false);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (source === "approach" && !location) {
      showRegisterNotice("error", "Capture a localização atual antes de salvar o cadastro originado de abordagem.");
      return;
    }
    setLoading(true);
    setMessage("");
    setRegisterNotice(null);
    try {
      const form = new FormData(event.currentTarget);
      const faceFiles = form.getAll("facePhotos").filter((item): item is File => item instanceof File && item.size > 0);
      const tattooFiles = form.getAll("tattoos").filter((item): item is File => item instanceof File && item.size > 0);
      const imageFiles = [...faceFiles, ...tattooFiles];
      // Compact aggressively for mobile uploads: about 240 KB for one image,
      // decreasing to a 45 KB floor when several images are selected.
      const targetBytes = Math.max(45_000, Math.floor(240_000 / Math.max(1, imageFiles.length)));
      const [compactedFaceFiles, compactedTattooFiles] = await withTimeout(
        Promise.all([
          Promise.all(faceFiles.map((file) => compressImage(file, targetBytes))),
          Promise.all(tattooFiles.map((file) => compressImage(file, targetBytes))),
        ]),
        45_000,
        "IMAGE_PROCESSING_TIMEOUT",
      );
      // A busca facial está desabilitada. As fotos são apenas armazenadas no cadastro,
      // portanto não bloqueamos o salvamento por ausência de rosto detectável.
      const tattooHashes = await withTimeout(
        Promise.all(compactedTattooFiles.map(safeVisualSignature)),
        45_000,
        "IMAGE_PROCESSING_TIMEOUT",
      );
      form.delete("facePhotos");
      form.delete("tattoos");
      form.set("facePhotoHashes", JSON.stringify([]));
      form.set("faceEmbeddings", JSON.stringify([]));
      form.set("tattooHashes", JSON.stringify(tattooHashes));
      compactedFaceFiles.forEach((file) => form.append("facePhotos", file));
      compactedTattooFiles.forEach((file) => form.append("tattoos", file));
      const imageBytes = [...compactedFaceFiles, ...compactedTattooFiles].reduce((total, file) => total + file.size, 0);
      if (imageBytes > 2_500_000) {
        showRegisterNotice("error", "Mesmo após a compactação, as imagens ultrapassam o limite total de envio. Envie menos fotos por vez.");
        setLoading(false);
        return;
      }
      form.set("source", source);
      form.set("addresses", JSON.stringify(addresses.filter((item) => item.address.trim())));
      form.set("seizedObjects", JSON.stringify(seizedObjects.filter((item) => item.description.trim())));
      form.set("factionAffiliated", factionAffiliated ? "yes" : "no");
      if (factionAffiliated) {
        if (factionChoice === "new") form.set("newFactionName", newFactionName);
        else form.set("factionId", factionChoice);
      }
      if (location) {
        form.set("latitude", location.latitude);
        form.set("longitude", location.longitude);
        form.set("accuracyMeters", location.accuracyMeters);
      }
      const controller = new AbortController();
      const requestTimeout = window.setTimeout(() => controller.abort(), 30_000);
      let response: Response;
      try {
        response = await apiFetch("/api/people", { method: "POST", body: form, signal: controller.signal });
      } finally {
        window.clearTimeout(requestTimeout);
      }
      if (response.status === 413) {
        showRegisterNotice("error", "As imagens selecionadas ultrapassam o limite de envio. Tente reduzir a quantidade de fotos.");
        setLoading(false);
        return;
      }
      let data: { person?: Person; error?: string } = {};
      try { data = await response.json() as { person?: Person; error?: string }; } catch { /* resposta não JSON do servidor */ }
      setLoading(false);
      if (!response.ok || !data.person) {
        showRegisterNotice("error", data.error ?? "Não foi possível salvar o cadastro. Verifique as imagens e tente novamente.");
        return;
      }
      showRegisterNotice("success", "Cadastro salvo com fotos, vínculos e auditoria.");
      setSelected(data.person);
      setResults([data.person]);
      setView("search");
      setAddresses([blankAddress()]);
      setSeizedObjects([]);
      setRegisterDraft(blankRegisterDraft());
      setFactionAffiliated(false);
      setFactionChoice("");
      setNewFactionName("");
      setLocation(null);
    } catch (error) {
      setLoading(false);
      const timeoutMessage = error instanceof Error && error.message === "IMAGE_PROCESSING_TIMEOUT"
        ? "A compactação das imagens demorou demais. Tente selecionar menos fotos ou imagens menores."
        : error instanceof Error && error.message === "FACE_PROCESSING_TIMEOUT"
          ? "A análise facial demorou demais. Verifique a conexão e tente novamente."
          : error instanceof DOMException && error.name === "AbortError"
            ? "O salvamento demorou mais que o esperado. Verifique sua conexão e tente novamente."
            : "Não foi possível concluir o envio. Verifique as imagens ou sua conexão e tente novamente.";
      showRegisterNotice("error", timeoutMessage);
    }
  }

  async function registerApproach(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!approachPerson || !approachLocation) {
      setMessage("Capture a localização atual para registrar a abordagem.");
      return;
    }
    setLoading(true);
    const form = new FormData(event.currentTarget);
    const response = await apiFetch(`/api/people/${approachPerson.id}/approaches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        occurredAt: form.get("occurredAt"),
        locationLabel: form.get("locationLabel"),
        notes: form.get("notes"),
        ...approachLocation,
      }),
    });
    const data = (await response.json()) as { error?: string };
    if (!response.ok) {
      setLoading(false);
      setMessage(data.error ?? "Não foi possível registrar a abordagem.");
      return;
    }
    const refreshed = await apiFetch(`/api/people?id=${approachPerson.id}`);
    const refreshedData = (await refreshed.json()) as { people: Person[] };
    const person = refreshedData.people[0];
    setSelected(person);
    setResults((items) => items.map((item) => item.id === person.id ? person : item));
    setApproachPerson(null);
    setApproachLocation(null);
    setLoading(false);
    setMessage("Abordagem e localização registradas na trilha de auditoria.");
  }

  function personUpdated(person: Person) {
    setSelected(person);
    setResults((items) => items.map((item) => item.id === person.id ? person : item));
    setEditPerson(null);
    setMessage("Dados atualizados e alteração registrada na auditoria.");
  }

  async function deletePerson(person: Person) {
    setLoading(true);
    const response = await apiFetch(`/api/people/${person.id}`, { method: "DELETE" });
    const data = await response.json() as { deleted?: boolean; error?: string };
    setLoading(false);
    if (!response.ok || !data.deleted) {
      setMessage(data.error ?? "Não foi possível apagar o cadastro.");
      return;
    }
    setSelected(null);
    setEditPerson(null);
    setResults((items) => items.filter((item) => item.id !== person.id));
    setMessage("Cadastro apagado. A exclusão foi registrada na auditoria.");
  }

  const visibleResults = submittedQuery && submittedQuery === query.trim() ? results : [];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden="true">S</span><strong>SICC</strong><span>BETA</span></div>
        <div className="environment">▣ <span>Ambiente interno</span></div>
        <button type="button" className="operator" onClick={() => navigate("account")} aria-label="Abrir minha conta"><span className="avatar">{initials(operator.name)}</span><span><b>{firstName}</b><small>{operator.role === "admin" ? "Administrador" : "Operador autorizado"}</small></span></button>
      </header>

      <aside className="sidebar" aria-label="Navegação principal">
        <span className="nav-label">NAVEGAÇÃO</span>
        <button className={view === "search" ? "active" : ""} onClick={() => navigate("search")}><i><NavIcon name="search" /></i>Consultar</button>
        <button className={view === "alerts" ? "active" : ""} onClick={() => navigate("alerts")}><i>⚠</i>Alertas</button>
        {operator.role === "admin" && <button className={view === "operators" ? "active" : ""} onClick={() => navigate("operators")}><i>♙</i>Operadores</button>}
        {operator.role === "admin" && <button className={view === "records" ? "active" : ""} onClick={() => navigate("records")}><i>▤</i>Cadastros</button>}
        <button className={view === "account" ? "active" : ""} onClick={() => navigate("account")}><i><NavIcon name="account" /></i>Conta</button>
        <div className="side-note">Uso restrito<br /><small>Ações monitoradas</small></div>
      </aside>

      <main className={`content view-${view}`}>
        <section className="page-heading">
          <span>VISÃO OPERACIONAL</span>
          <h1>{title}</h1>
          <p>Consulte com finalidade legítima e registre apenas informações objetivas e verificadas.</p>
        </section>

        {view === "search" && (
          <section className="search-card">
            <div className="search-tabs" role="tablist" aria-label="Tipo de consulta">
              <button className={searchMode === "text" ? "active" : ""} onClick={() => setSearchMode("text")}>⌨ Nome/alcunha</button>
              {IMAGE_SEARCH_ENABLED && <button className={searchMode === "face" ? "active" : ""} onClick={() => setSearchMode("face")}>◎ Rosto</button>}
              {IMAGE_SEARCH_ENABLED && <button className={searchMode === "tattoo" ? "active" : ""} onClick={() => setSearchMode("tattoo")}>◇ Tatuagem</button>}
            </div>
            {searchMode === "text" ? (
              <form onSubmit={(event) => event.preventDefault()}>
                <label htmlFor="query">Nome, CPF, alcunha ou nome da mãe</label>
                <div className="search-row">
                  <div className="input-wrap"><span>⌕</span><input id="query" value={query} onChange={(event) => { setQuery(event.target.value); setSubmittedQuery(""); }} placeholder="Ex.: João da Silva, 000..., Baixinho ou Maria da Silva" /></div>
                  <button type="button" className="primary" disabled={loading} onClick={() => void search()}>{loading ? "Consultando…" : "Consultar"}</button>
                </div>
              </form>
            ) : (
              <form className="image-search" onSubmit={searchImage}>
                <label htmlFor="search-image">{searchMode === "face" ? "Foto facial de referência" : "Foto da tatuagem de referência"}</label>
                <div className="search-row">
                  <label className="file-drop"><input id="search-image" name="image" type="file" accept="image/jpeg,image/png,image/webp" required /><span>▧ Escolher da galeria ou usar a câmera</span></label>
                  <button className="primary" disabled={loading}>{loading ? "Analisando…" : "Verificar"}</button>
                </div>
                <div className="biometric-note"><b>Busca visual por similaridade:</b> os candidatos são ordenados por semelhança visual aproximada. O resultado é apenas apoio à conferência e não confirma identidade.</div>
              </form>
            )}
            <small className="people-total">Pessoas cadastradas no SICC: {totalPeopleCount === null ? "…" : totalPeopleCount}</small>
            <small>▣ Toda consulta é vinculada ao operador e registrada para auditoria.</small>
          </section>
        )}

        {message && <div className="feedback" role="status">{message}</div>}

        {view === "search" && visibleResults.length > 0 && (
          <section className="panel results-panel">
            <div className="panel-title"><h2>Resultados da consulta</h2><span>{visibleResults.length} resultado(s)</span></div>
            <PersonList people={visibleResults} onSelect={setSelected} />
          </section>
        )}

        {view === "search" && submittedQuery.length >= 3 && visibleResults.length === 0 && (
          <section className="not-found-action">
            <b>Essa pessoa ainda não está cadastrada?</b>
            <span>Crie uma ficha usando o termo pesquisado como ponto de partida.</span>
            <button className="primary" onClick={registerFromSearch}>＋ Cadastrar esta pessoa</button>
          </section>
        )}

        {view === "search" && !submittedQuery && query.trim().length < 3 && !message && (
          <button className="floating-register" onClick={() => navigate("register")}><NavIcon name="plus" /><span>Novo cadastro</span></button>
        )}

        {view === "alerts" && <AlertsView operator={operator} />}

        {view === "account" && (
          <section className="account-card panel">
            <div className="account-identity"><span className="account-avatar">{initials(operator.name)}</span><div><small>OPERADOR AUTENTICADO</small><h2>{operator.rank ? `${rankLabel(operator.rank)} ${operator.warName}` : operator.name}</h2><p>{operator.email}</p></div></div>
            <dl>
              <div><dt>Perfil de acesso</dt><dd>{operator.role === "admin" ? "Administrador" : "Operador autorizado"}</dd></div>
              <div><dt>Ambiente</dt><dd>SICC Beta · interno</dd></div>
              <div><dt>Nível da conta</dt><dd>{operator.role === "admin" ? "Administrador" : "Operador"}</dd></div>
              <div><dt>Convidado por</dt><dd>{operator.invitedBy ?? "Ativação inicial da plataforma"}</dd></div>
              <div><dt>Auditoria</dt><dd>Consultas e alterações registradas</dd></div>
            </dl>
            <div className="warning"><b>Uso pessoal e intransferível</b><small>As ações realizadas no sistema ficam vinculadas a este usuário.</small></div>
            <div className="invite-panel"><div><b>Convidar operador</b><small>O link expira em 8 horas e permite um único cadastro.</small></div><button className="secondary" disabled={loading || inviteGenerating || bulkInviteGenerating} onClick={() => void createInvite("single")}>{inviteGenerating ? <><span className="mini-loader" aria-hidden="true" /> Gerando link…</> : "Gerar link"}</button>{invite && <div className="invite-code"><strong>Link de uso único</strong><small>Expira em {formatDate(invite.expiresAt)}</small><button onClick={() => void copyInviteLink()}>{inviteCopyStatus === "copied" ? "Copiado ✓" : "Copiar link"}</button><code>{invite.link}</code>{inviteCopyStatus === "copied" && <span className="copy-status success">Link copiado.</span>}{inviteCopyStatus === "error" && <span className="copy-status error">Não foi possível copiar. Selecione o link manualmente.</span>}</div>}</div>
             {operator.role === "admin" && <div className="invite-panel bulk-invite-panel"><div><b>Link para vários cadastros</b><small>Exclusivo do administrador. Pode ser usado por várias pessoas até expirar ou ser revogado.</small></div><button className="secondary" disabled={loading || inviteGenerating || bulkInviteGenerating} onClick={() => void createInvite("bulk")}>{bulkInviteGenerating ? <><span className="mini-loader" aria-hidden="true" /> Gerando link…</> : "Gerar link reutilizável"}</button>{bulkInvite && <div className="invite-code"><strong>{bulkInvite.revokedAt ? "Link revogado" : "Link reutilizável ativo"}</strong><small>Expira em {formatDate(bulkInvite.expiresAt)} · Usado por {bulkInvite.useCount ?? 0} pessoa(s)</small><button disabled={Boolean(bulkInvite.revokedAt)} onClick={() => void copyInviteLink("bulk")}>{bulkInviteCopyStatus === "copied" ? "Copiado ✓" : "Copiar link"}</button><code>{bulkInvite.link}</code>{!bulkInvite.revokedAt && <button type="button" className="danger-outline" onClick={() => setBulkInviteConfirm(true)}>Revogar link</button>}{bulkInviteCopyStatus === "copied" && <span className="copy-status success">Link copiado.</span>}{bulkInviteCopyStatus === "error" && <span className="copy-status error">Não foi possível copiar. Selecione o link manualmente.</span>}</div>}{bulkInviteConfirm && <ConfirmModal title="Revogar link reutilizável?" message="Novos cadastros não poderão mais usar este link. Cadastros já concluídos permanecem ativos." confirmLabel="Revogar link" onCancel={() => setBulkInviteConfirm(false)} onConfirm={async () => { setBulkInviteConfirm(false); await revokeBulkInvite(); }} />}</div>}
             {activeInvites.filter((item) => item.id !== invite?.id && item.id !== bulkInvite?.id).length > 0 && <div className="invite-panel active-invites-panel"><div><b>Outros links ativos</b><small>Links permanecem disponíveis até expirar ou serem utilizados.</small></div>{activeInvites.filter((item) => item.id !== invite?.id && item.id !== bulkInvite?.id).map((item) => <div className="invite-code" key={item.id}><strong>{item.kind === "bulk" ? "Link reutilizável ativo" : "Link de uso único"}</strong><small>Expira em {formatDate(item.expiresAt)}{item.kind === "bulk" && item.useCount ? ` · ${item.useCount} uso(s)` : ""}</small><button onClick={() => void copySpecificInvite(item)}>Copiar link</button><code>{item.link}</code></div>)}</div>}
             <button className="logout-button" onClick={() => setLogoutConfirm(true)}>Sair da conta</button>
          </section>
        )}

        {view === "operators" && operator.role === "admin" && <AdminList kind="operators" />}
        {view === "records" && operator.role === "admin" && <AdminList kind="records" />}

        {view === "register" && (
          <form ref={registerFormRef} className="register-form panel" onSubmit={register}>
            <div className="import-infoseg"><div><b>Preenchimento rápido</b><span>Cole os dados copiados do Infoseg e revise antes de salvar.</span></div><button type="button" className="secondary" onClick={pasteFromInfoseg}>▣ Colar do Infoseg</button></div>
            <FormSection title="Identificação" subtitle="Dados civis e operacionais">
              <div className="form-grid">
                <label className="wide">Nome completo *<input name="fullName" required minLength={3} value={registerDraft.fullName} onChange={(event) => setRegisterDraft((draft) => ({ ...draft, fullName: event.target.value }))} placeholder="Informe o nome civil" /></label>
                <label>CPF *<input name="cpf" required inputMode="numeric" value={registerDraft.cpf} onChange={(event) => setRegisterDraft((draft) => ({ ...draft, cpf: event.target.value }))} placeholder="000.000.000-00" /></label>
                <label>Alcunha<input name="nickname" placeholder="Nome pelo qual é conhecido" /></label>
                <label>Data de nascimento<input name="birthDate" type="date" value={registerDraft.birthDate} onChange={(event) => setRegisterDraft((draft) => ({ ...draft, birthDate: event.target.value }))} /></label>
                <label>Nome da mãe<input name="motherName" value={registerDraft.motherName} onChange={(event) => setRegisterDraft((draft) => ({ ...draft, motherName: event.target.value }))} placeholder="Auxilia a confirmação de identidade" /></label>
                <label>Cidade de referência<input name="city" value={registerDraft.city} onChange={(event) => setRegisterDraft((draft) => ({ ...draft, city: event.target.value }))} placeholder="Município" /></label>
                <label>UF<select name="state" value={registerDraft.state} onChange={(event) => setRegisterDraft((draft) => ({ ...draft, state: event.target.value }))}><option>PB</option><option>RN</option><option>PE</option><option>CE</option></select></label>
                <label>Situação<select name="status" defaultValue="alive"><option value="alive">Vivo</option><option value="dead">Morto</option></select></label><label>Custódia<select name="custodyStatus" defaultValue="free"><option value="free">Em liberdade</option><option value="detained">Preso</option></select></label>
              </div>
              <div className="faction-fields">
                <label className="faction-toggle">Faccionado?<select value={factionAffiliated ? "yes" : "no"} onChange={(event) => { const enabled = event.target.value === "yes"; setFactionAffiliated(enabled); if (!enabled) { setFactionChoice(""); setNewFactionName(""); } }}><option value="no">Não</option><option value="yes">Sim</option></select></label>
                {factionAffiliated && <label>Facção<select value={factionChoice} onChange={(event) => setFactionChoice(event.target.value)} required><option value="">Selecione</option>{factions.map((faction) => <option key={faction.id} value={faction.id}>{faction.name}</option>)}<option value="new">＋ Adicionar nova facção</option></select></label>}
                {factionAffiliated && factionChoice === "new" && <label className="wide">Nome da nova facção<input value={newFactionName} onChange={(event) => setNewFactionName(event.target.value)} required minLength={2} placeholder="Informe o nome" /></label>}
              </div>
            </FormSection>

            <FormSection title="Imagens de identificação" subtitle="As imagens serão compactadas automaticamente antes do envio">
              <div className="photo-grid">
                <div className="photo-record"><PhotoInput name="facePhotos" label="Fotos do rosto" multiple /><label>Data das fotos *<input name="facePhotoDate" type="date" defaultValue={currentBrasiliaDate()} required /></label></div>
                <div className="photo-record"><PhotoInput name="tattoos" label="Fotos de tatuagens" multiple /><label>Data das fotos<input name="tattooPhotoDate" type="date" defaultValue={currentBrasiliaDate()} /></label></div>
              </div>
            </FormSection>

            <FormSection title="Endereços" subtitle="Inclua apenas vínculos conhecidos">
              <div className="repeat-list">
                {addresses.map((address, index) => (
                  <div className="repeat-card" key={index}>
                    <div className="repeat-head"><b>Endereço {index + 1}</b>{addresses.length > 1 && <button type="button" onClick={() => setAddresses((items) => items.filter((_, itemIndex) => itemIndex !== index))}>Remover</button>}</div>
                    <div className="form-grid">
                      <label>Tipo<input value={address.label} onChange={(event) => setAddresses((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))} placeholder="Residencial, trabalho..." /></label>
                      <label className="wide">Logradouro e número<input value={address.address} onChange={(event) => setAddresses((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, address: event.target.value } : item))} placeholder="Rua, número, bairro e complemento" /></label>
                      <label>Cidade<input value={address.city} onChange={(event) => setAddresses((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, city: event.target.value } : item))} /></label>
                      <label>UF<input value={address.state} maxLength={2} onChange={(event) => setAddresses((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, state: event.target.value.toUpperCase() } : item))} /></label>
                      <label className="wide">Observação do endereço<input value={address.notes} onChange={(event) => setAddresses((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, notes: event.target.value } : item))} placeholder="Ex.: endereço da mãe" /></label>
                    </div>
                  </div>
                ))}
                <button type="button" className="add-row" onClick={() => setAddresses((items) => [...items, blankAddress()])}>＋ Adicionar outro endereço</button>
              </div>
            </FormSection>

            <FormSection title="Objetos apreendidos" subtitle="Preencha somente quando houver vínculo documentado">
              <div className="repeat-list">
                {seizedObjects.map((item, index) => (
                  <div className="repeat-card" key={index}>
                    <div className="repeat-head"><b>Registro {index + 1}</b><button type="button" onClick={() => setSeizedObjects((items) => items.filter((_, itemIndex) => itemIndex !== index))}>Remover</button></div>
                    <div className="form-grid">
                      <label className="wide">Observação<textarea rows={3} value={item.description} onChange={(event) => setSeizedObjects((items) => items.map((current, itemIndex) => itemIndex === index ? { ...current, description: event.target.value } : current))} placeholder="Descreva os objetos apreendidos e as informações relevantes" /></label>
                      <label>Data da apreensão<input type="date" value={item.seizedAt} onChange={(event) => setSeizedObjects((items) => items.map((current, itemIndex) => itemIndex === index ? { ...current, seizedAt: event.target.value } : current))} /></label>
                    </div>
                  </div>
                ))}
                <button type="button" className="add-row" onClick={() => setSeizedObjects((items) => [...items, blankObject()])}>＋ Adicionar objeto apreendido</button>
              </div>
            </FormSection>

            <FormSection title="Origem do registro" subtitle="A localização só é capturada quando o cadastro decorre de abordagem">
              <div className="source-options">
                <label><input type="radio" checked={source === "administrative"} onChange={() => { setSource("administrative"); setLocation(null); }} /> Cadastro administrativo</label>
                <label><input type="radio" checked={source === "approach"} onChange={() => setSource("approach")} /> Abordagem em andamento</label>
              </div>
              {source === "approach" && (
                <div className="geo-card">
                  <label>Data e hora da abordagem<input name="approachDate" type="datetime-local" defaultValue={currentBrasiliaDateTime()} /></label>
                  <label>Referência do local<input name="locationLabel" placeholder="Ex.: Av. Epitácio Pessoa, Tambauzinho" /></label>
                  <label className="wide">Observação da abordagem<textarea name="approachNotes" rows={2} placeholder="Motivo e circunstâncias objetivas" /></label>
                  <button type="button" className={location ? "location-ok" : "secondary"} onClick={() => captureLocation(setLocation)}>{location ? "✓ Localização capturada" : "⌖ Capturar localização atual"}</button>
                  {location && <small>Precisão aproximada: {location.accuracyMeters} m. Coordenadas vinculadas somente a esta abordagem.</small>}
                </div>
              )}
            </FormSection>

            <label className="wide notes-field">Observação geral<textarea name="notes" rows={4} value={registerDraft.notes} onChange={(event) => setRegisterDraft((draft) => ({ ...draft, notes: event.target.value }))} placeholder="Registre somente informações objetivas, verificáveis e pertinentes." /></label>
            <div className="form-actions"><button type="button" className="secondary" onClick={() => navigate("search")}>Cancelar</button><button className="primary" disabled={loading}>{loading ? "Salvando…" : "Salvar cadastro"}</button></div>
          </form>
        )}
      </main>

      {!editPerson && <nav className="bottom-nav" aria-label="Navegação mobile">
        <button className={view === "search" ? "active" : ""} onClick={() => navigate("search")}><i><NavIcon name="search" /></i><span>Consultar</span></button>
        <button className={view === "alerts" ? "active" : ""} onClick={() => navigate("alerts")}><i>⚠</i><span>Alertas</span></button>
        {operator.role === "admin" && <button className={view === "operators" ? "active" : ""} onClick={() => navigate("operators")}><i>♙</i><span>Operadores</span></button>}
        {operator.role === "admin" && <button className={view === "records" ? "active" : ""} onClick={() => navigate("records")}><i>▤</i><span>Cadastros</span></button>}
        <button className={view === "account" ? "active" : ""} onClick={() => navigate("account")}><i><NavIcon name="account" /></i><span>Conta</span></button>
      </nav>}

      {selected && <PersonModal
        person={selected}
        onClose={() => setSelected(null)}
        onApproach={(person) => { setApproachPerson(person); setSelected(null); }}
        onEdit={(person) => { setEditPerson(person); setSelected(null); void loadFactions(); }}
        onDelete={deletePerson}
      />}

      {editPerson && (
        <EditPersonModal
          person={editPerson}
          factions={factions}
          loading={loading}
          onClose={() => setEditPerson(null)}
          onLoading={setLoading}
          onMessage={setMessage}
          onUpdated={personUpdated}
        />
      )}

      {approachPerson && (
        <div className="modal-backdrop" onClick={() => setApproachPerson(null)}>
          <form className="person-modal approach-modal" onSubmit={registerApproach} onClick={(event) => event.stopPropagation()}>
            <button type="button" className="close" onClick={() => setApproachPerson(null)} aria-label="Fechar">×</button>
            <small className="eyebrow">NOVA ABORDAGEM</small>
            <h2>{approachPerson.fullName}</h2>
            <p>A localização atual é obrigatória e será vinculada exclusivamente a este registro.</p>
            <label>Data e hora<input name="occurredAt" type="datetime-local" defaultValue={currentBrasiliaDateTime()} /></label>
            <label>Referência do local<input name="locationLabel" placeholder="Rua, bairro ou ponto de referência" /></label>
            <label>Observação<textarea name="notes" rows={3} placeholder="Circunstâncias objetivas da abordagem" /></label>
            <button type="button" className={approachLocation ? "location-ok" : "secondary"} onClick={() => captureLocation(setApproachLocation)}>{approachLocation ? "✓ Localização capturada" : "⌖ Capturar localização atual"}</button>
            {approachLocation && <small>Precisão aproximada: {approachLocation.accuracyMeters} m.</small>}
            <button className="primary full-button" disabled={loading}>{loading ? "Registrando…" : "Registrar abordagem"}</button>
          </form>
        </div>
      )}

      {registerNotice && (
        <div className="modal-backdrop notice-backdrop">
          <section className={`notice-modal ${registerNotice.kind}`} role="alertdialog" aria-modal="true" aria-labelledby="register-notice-title">
            <div className="notice-icon" aria-hidden="true">{registerNotice.kind === "success" ? "✓" : "!"}</div>
            <small className="eyebrow">{registerNotice.kind === "success" ? "CADASTRO CONCLUÍDO" : "NÃO FOI POSSÍVEL SALVAR"}</small>
            <h2 id="register-notice-title">{registerNotice.kind === "success" ? "Cadastro salvo" : "Revise o cadastro"}</h2>
            <p>{registerNotice.text}</p>
            <button className="primary full-button" onClick={closeRegisterNotice}>Entendi</button>
          </section>
        </div>
      )}
      {logoutConfirm && <ConfirmModal title="Sair da conta?" message="A sessão atual será encerrada neste dispositivo." confirmLabel="Sair" onCancel={() => setLogoutConfirm(false)} onConfirm={async () => { setLogoutConfirm(false); await onLogout(); }} />}
    </div>
  );
}

function AlertsView({ operator }: { operator: Operator }) {
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [municipalityFilter, setMunicipalityFilter] = useState("");
  const [neighborhoodFilter, setNeighborhoodFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("open");
  const [appliedCategoryFilter, setAppliedCategoryFilter] = useState("");
  const [appliedMunicipalityFilter, setAppliedMunicipalityFilter] = useState("");
  const [appliedNeighborhoodFilter, setAppliedNeighborhoodFilter] = useState("");
  const [appliedStatusFilter, setAppliedStatusFilter] = useState("open");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [alertPage, setAlertPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedAlert, setSelectedAlert] = useState<AlertRecord | null>(null);
  const [categoryKey, setCategoryKey] = useState(ALERT_CATEGORIES[0].key);
  const [municipalityState, setMunicipalityState] = useState<"" | "PB" | "RN">("");
  const [municipality, setMunicipality] = useState("");
  const [municipalityQuery, setMunicipalityQuery] = useState("");
  const [neighborhood, setNeighborhood] = useState("");
  const [neighborhoodQuery, setNeighborhoodQuery] = useState("");
  const [localityPicker, setLocalityPicker] = useState<"city" | "neighborhood" | null>(null);
  const [peopleInfo, setPeopleInfo] = useState("");
  const [vehicleInfo, setVehicleInfo] = useState("");
  const [description, setDescription] = useState("");
  const [occurredAt, setOccurredAt] = useState(currentBrasiliaDateTime);
  const [locationLink, setLocationLink] = useState("");
  const [images, setImages] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const [confirmation, setConfirmation] = useState<{ title: string; message: string; action: () => Promise<void> } | null>(null);

  const selectedCategory = ALERT_CATEGORIES.find((item) => item.key === categoryKey) ?? ALERT_CATEGORIES[0];
  const citySuggestions = LOCALITY_CITIES.filter((city) => (!municipalityState || LOCALITY_STATES[city] === municipalityState) && (!municipalityQuery.trim() || normalizeSearch(city).includes(normalizeSearch(municipalityQuery)))).slice(0, 8);
  const neighborhoodSuggestions = (LOCALITIES[municipality] ?? []).filter((item) => !neighborhoodQuery.trim() || normalizeSearch(item).includes(normalizeSearch(neighborhoodQuery))).slice(0, 10);

  async function loadAlerts() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (appliedCategoryFilter) params.set("category", appliedCategoryFilter);
      if (appliedMunicipalityFilter.trim()) params.set("municipality", appliedMunicipalityFilter.trim());
      if (appliedNeighborhoodFilter.trim()) params.set("neighborhood", appliedNeighborhoodFilter.trim());
      if (appliedStatusFilter) params.set("status", appliedStatusFilter);
      const response = await apiFetch(`/api/alerts?${params.toString()}`, { cache: "no-store" });
      const data = await response.json() as { alerts?: AlertRecord[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Não foi possível carregar os alertas.");
      setAlerts(data.alerts ?? []);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Não foi possível carregar os alertas.");
    } finally {
      setLoading(false);
    }
  }

  // Filter changes intentionally synchronize the list with the API.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { setAlertPage(1); void loadAlerts(); }, [appliedCategoryFilter, appliedMunicipalityFilter, appliedNeighborhoodFilter, appliedStatusFilter]);
  useEffect(() => () => previews.forEach((url) => URL.revokeObjectURL(url)), [previews]);

  function selectImages(event: ChangeEvent<HTMLInputElement>) {
    previews.forEach((url) => URL.revokeObjectURL(url));
    const selected = Array.from(event.target.files ?? []);
    setImages(selected);
    setPreviews(selected.map((file) => URL.createObjectURL(file)));
  }

  function clearForm() {
    previews.forEach((url) => URL.revokeObjectURL(url));
    setImages([]); setPreviews([]); setCategoryKey(ALERT_CATEGORIES[0].key); setMunicipalityState(""); setMunicipality(""); setMunicipalityQuery(""); setNeighborhood(""); setNeighborhoodQuery(""); setLocalityPicker(null); setPeopleInfo(""); setVehicleInfo(""); setDescription(""); setOccurredAt(currentBrasiliaDateTime()); setLocationLink(""); setOpenSections({});
  }

  function selectMunicipality(value: string) {
    setMunicipality(value);
    setMunicipalityState(LOCALITY_STATES[value] ?? "");
    setMunicipalityQuery(value);
    setNeighborhood("");
    setNeighborhoodQuery("");
    setLocalityPicker(null);
  }

  function selectMunicipalityState(value: "PB" | "RN") {
    setMunicipalityState(value);
    setMunicipality("");
    setMunicipalityQuery("");
    setNeighborhood("");
    setNeighborhoodQuery("");
    setLocalityPicker("city");
  }

  function selectNeighborhood(value: string) {
    setNeighborhood(value);
    setNeighborhoodQuery(value);
    setLocalityPicker(null);
  }

  function toggleSection(section: string) {
    setOpenSections((current) => ({ ...current, [section]: !current[section] }));
  }

  async function createAlert(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!municipalityState || !municipality || LOCALITY_STATES[municipality] !== municipalityState || !neighborhood || !LOCALITIES[municipality]?.includes(neighborhood) || !description.trim()) { setNotice("Selecione o estado, a cidade e o bairro nas listas predefinidas e informe a descrição da ocorrência."); return; }
    setSaving(true); setNotice("");
    try {
      const targetBytes = Math.max(70_000, Math.floor(900_000 / Math.max(1, images.length)));
      const compacted = await Promise.all(images.map((file) => compressImage(file, targetBytes)));
      if (compacted.reduce((total, file) => total + file.size, 0) > 2_500_000) throw new Error("Mesmo após a compactação, as imagens ultrapassam o limite total. Envie menos fotos.");
      const form = new FormData();
      form.set("categoryKey", categoryKey); form.set("municipalityState", municipalityState); form.set("municipality", municipality); form.set("neighborhood", neighborhood); form.set("peopleInfo", peopleInfo.trim()); form.set("vehicleInfo", vehicleInfo.trim()); form.set("description", description.trim()); form.set("occurredAt", occurredAt);
      if (locationLink.trim()) form.set("locationLink", locationLink.trim());
      compacted.forEach((file) => form.append("images", file));
      const response = await apiFetch("/api/alerts", { method: "POST", body: form });
      const data = await response.json() as { alert?: AlertRecord; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Não foi possível publicar o alerta.");
      clearForm(); setShowCreate(false); setAppliedStatusFilter("open"); setStatusFilter("open"); setNotice("QTC publicado e visível aos operadores autenticados."); await loadAlerts();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Não foi possível publicar o alerta.");
    } finally { setSaving(false); }
  }

  async function changeStatus(alert: AlertRecord) {
    const next = alert.status === "resolved" ? "open" : "resolved";
    if (next === "resolved") {
      setConfirmation({ title: "Marcar QTC como resolvido?", message: "O QTC ficará identificado como resolvido e registrará o operador responsável.", action: async () => { await changeStatusConfirmed(alert, next); } });
      return;
    }
    await changeStatusConfirmed(alert, next);
  }

  async function changeStatusConfirmed(alert: AlertRecord, next: "open" | "resolved") {
    setSaving(true); setNotice("");
    try {
      const response = await apiFetch(`/api/alerts/${alert.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: next }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Não foi possível atualizar o QTC.");
      await loadAlerts(); setSelectedAlert((current) => current ? { ...current, status: next, resolvedBy: next === "resolved" ? operator.email : null, resolvedByName: next === "resolved" ? operator.name : null, resolvedAt: next === "resolved" ? new Date().toISOString() : null } : null); setNotice(next === "resolved" ? "QTC marcado como resolvido." : "QTC reaberto.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Não foi possível atualizar o QTC."); } finally { setSaving(false); }
  }

  async function deleteAlert(alert: AlertRecord) {
    setConfirmation({ title: "Apagar este QTC?", message: `O QTC “${alert.categoryLabel}” de ${alert.municipality} e suas imagens serão removidos permanentemente.`, action: async () => { await deleteAlertConfirmed(alert); } });
  }

  async function deleteAlertConfirmed(alert: AlertRecord) {
    setSaving(true); setNotice("");
    try {
      const response = await apiFetch(`/api/alerts/${alert.id}`, { method: "DELETE" });
      const data = await response.json() as { deleted?: boolean; error?: string };
      if (!response.ok || !data.deleted) throw new Error(data.error ?? "Não foi possível apagar o QTC.");
      setSelectedAlert(null);
      setNotice("QTC apagado e exclusão registrada na auditoria.");
      await loadAlerts();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Não foi possível apagar o QTC.");
    } finally { setSaving(false); }
  }

  const alertPageSize = 10;
  const alertPageCount = Math.max(1, Math.ceil(alerts.length / alertPageSize));
  const pagedAlerts = alerts.slice((Math.min(alertPage, alertPageCount) - 1) * alertPageSize, Math.min(alertPage, alertPageCount) * alertPageSize);
  const groups = ALERT_PRIORITY_ORDER.map((priority) => ({ priority, items: pagedAlerts.filter((item) => item.priority === priority) })).filter((group) => group.items.length > 0);
  if (selectedAlert && !showCreate) return <><AlertDetailsPage alert={selectedAlert} saving={saving} canDelete={operator.role === "admin" || selectedAlert.createdBy === operator.email} onBack={() => setSelectedAlert(null)} onChangeStatus={() => void changeStatus(selectedAlert)} onDelete={() => void deleteAlert(selectedAlert)} />{notice && <div className="feedback" role="status">{notice}</div>}{confirmation && <ConfirmModal title={confirmation.title} message={confirmation.message} confirmLabel="Confirmar" onCancel={() => setConfirmation(null)} onConfirm={async () => { const action = confirmation.action; setConfirmation(null); await action(); }} />}</>;
  return <div className="alerts-page">
    {!showCreate && <>
      <div className="alerts-toolbar panel">
        <div><b>QTCs operacionais</b><small>Ocorrências compartilhadas entre os operadores autenticados.</small></div>
        <button className="secondary filter-toggle" onClick={() => setFiltersOpen((value) => !value)}>☷ {filtersOpen ? "Fechar filtros" : "Abrir filtros"}{(appliedCategoryFilter || appliedMunicipalityFilter || appliedStatusFilter !== "open") ? " · ativos" : ""}</button>
        {filtersOpen && <div className="alert-filters"><label>Status<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="open">Em aberto</option><option value="resolved">Resolvidos</option><option value="">Todos</option></select></label><label>Categoria<select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="">Todas</option>{ALERT_CATEGORIES.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label><label className="filter-city">Município<input value={municipalityFilter} onChange={(event) => setMunicipalityFilter(event.target.value)} placeholder="Filtrar cidade" /></label><label className="filter-neighborhood">Bairro<input value={neighborhoodFilter} onChange={(event) => setNeighborhoodFilter(event.target.value)} placeholder="Filtrar bairro" /></label><div className="filter-actions"><button type="button" className="secondary" onClick={() => { setCategoryFilter(""); setMunicipalityFilter(""); setNeighborhoodFilter(""); setStatusFilter("open"); setAppliedCategoryFilter(""); setAppliedMunicipalityFilter(""); setAppliedNeighborhoodFilter(""); setAppliedStatusFilter("open"); setFiltersOpen(false); }}>Limpar</button><button type="button" className="primary" onClick={() => { setAppliedCategoryFilter(categoryFilter); setAppliedMunicipalityFilter(municipalityFilter); setAppliedNeighborhoodFilter(neighborhoodFilter); setAppliedStatusFilter(statusFilter); setFiltersOpen(false); }}>Aplicar filtros</button></div></div>}
      </div>
    </>}

    {showCreate && <form className="panel alert-form" onSubmit={createAlert}>
      <div className="panel-title"><div><h2>Novo QTC</h2><span>Descreva somente fatos objetivos e relevantes.</span></div></div>
      <div className="alert-form-sections">
        <AlertFormSection title="Classificação e identificação" subtitle="Categoria, município e momento da ocorrência" open={Boolean(openSections.classification)} onToggle={() => toggleSection("classification")}>
          <div className="alert-form-grid"><label className="wide">Categoria *<select value={categoryKey} onChange={(event) => setCategoryKey(event.target.value)} required>{ALERT_CATEGORIES.map((item) => <option key={item.key} value={item.key}>{item.label} · prioridade {ALERT_PRIORITY_LABEL[item.priority]}</option>)}</select><small className={`priority-chip ${selectedCategory.priority}`}>{ALERT_PRIORITY_LABEL[selectedCategory.priority]} · {selectedCategory.description}</small></label><label>Estado (UF) *<select value={municipalityState} onChange={(event) => { const value = event.target.value as "" | "PB" | "RN"; if (value) selectMunicipalityState(value); else { setMunicipalityState(""); setMunicipality(""); setMunicipalityQuery(""); setNeighborhood(""); setNeighborhoodQuery(""); setLocalityPicker(null); } }} required><option value="">Selecione o estado</option><option value="PB">Paraíba (PB)</option><option value="RN">Rio Grande do Norte (RN)</option></select></label><label className="locality-field">Cidade *<div className="locality-autocomplete"><input value={municipalityQuery} onFocus={() => municipalityState && setLocalityPicker("city")} onBlur={() => window.setTimeout(() => setLocalityPicker((current) => current === "city" ? null : current), 120)} onChange={(event) => { const value = event.target.value; setMunicipalityQuery(value); const match = LOCALITY_CITIES.find((city) => LOCALITY_STATES[city] === municipalityState && normalizeSearch(city) === normalizeSearch(value)); setMunicipality(match ?? ""); setNeighborhood(""); setNeighborhoodQuery(""); }} disabled={!municipalityState} required placeholder={municipalityState ? "Digite para pesquisar a cidade" : "Selecione o estado primeiro"} autoComplete="off" />{localityPicker === "city" && citySuggestions.length > 0 && <div className="locality-suggestions">{citySuggestions.map((city) => <button type="button" key={city} onMouseDown={(event) => event.preventDefault()} onClick={() => selectMunicipality(city)}>{city}</button>)}</div>}</div></label><label className="locality-field">Bairro *<div className="locality-autocomplete"><input value={neighborhoodQuery} onFocus={() => municipality && setLocalityPicker("neighborhood")} onBlur={() => window.setTimeout(() => setLocalityPicker((current) => current === "neighborhood" ? null : current), 120)} onChange={(event) => { const value = event.target.value; setNeighborhoodQuery(value); const match = (LOCALITIES[municipality] ?? []).find((item) => normalizeSearch(item) === normalizeSearch(value)); setNeighborhood(match ?? ""); }} disabled={!municipality} required placeholder={municipality ? "Digite para pesquisar o bairro" : "Selecione a cidade primeiro"} autoComplete="off" />{localityPicker === "neighborhood" && neighborhoodSuggestions.length > 0 && <div className="locality-suggestions">{neighborhoodSuggestions.map((item) => <button type="button" key={item} onMouseDown={(event) => event.preventDefault()} onClick={() => selectNeighborhood(item)}>{item}</button>)}</div>}</div></label><label className="wide">Data e hora da ocorrência *<input type="datetime-local" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} required /></label></div>
        </AlertFormSection>
        <AlertFormSection title="Pessoas e veículo" subtitle="Informações vinculadas, quando houver" open={Boolean(openSections.involved)} onToggle={() => toggleSection("involved")}>
          <div className="alert-form-grid"><label>Pessoas envolvidas<textarea rows={3} value={peopleInfo} onChange={(event) => setPeopleInfo(event.target.value)} placeholder="Nome, alcunha ou descrição, se houver" /></label><label>Veículo<textarea rows={3} value={vehicleInfo} onChange={(event) => setVehicleInfo(event.target.value)} placeholder="Placa, modelo, cor e características" /></label></div>
        </AlertFormSection>
        <AlertFormSection title="Descrição da ocorrência" subtitle="Relato objetivo e providências necessárias" open={Boolean(openSections.description)} onToggle={() => toggleSection("description")}>
          <label className="alert-block-label">Descrição da ocorrência *<textarea rows={5} value={description} onChange={(event) => setDescription(event.target.value)} required placeholder="O que aconteceu, quando e quais providências são necessárias?" /></label>
        </AlertFormSection>
        <AlertFormSection title="Localização ou rastreio" subtitle="Cole um link, se disponível" open={Boolean(openSections.location)} onToggle={() => toggleSection("location")}>
          <label className="alert-block-label">Link da localização ou rastreio <small>Google Maps, Waze ou sistema de rastreamento.</small><input type="url" value={locationLink} onChange={(event) => setLocationLink(event.target.value)} placeholder="https://maps.google.com/..." /></label>
        </AlertFormSection>
        <AlertFormSection title="Imagens" subtitle="Veículo, pessoa, print ou outro material pertinente" open={Boolean(openSections.images)} onToggle={() => toggleSection("images")}>
          <label className="alert-file-label"><span>Selecionar imagens <small>(até 6; serão compactadas)</small></span><input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={selectImages} />{previews.length > 0 && <div className="alert-previews">{previews.map((url, index) => <img key={url} src={url} alt={`Prévia ${index + 1}`} />)}</div>}</label>
        </AlertFormSection>
      </div>
      <div className="form-actions alert-actions"><button type="button" className="secondary" onClick={() => { clearForm(); setShowCreate(false); }}>Cancelar</button><button className="primary" disabled={saving}>{saving ? "Publicando…" : "Publicar QTC"}</button></div>
    </form>}

    {notice && <div className="feedback" role="status">{notice}</div>}
    {!showCreate && (loading ? <section className="panel alerts-loading"><span className="mini-loader" /> Carregando QTCs…</section> : !alerts.length ? <section className="panel empty-alerts"><span>✓</span><b>{appliedStatusFilter === "resolved" ? "Nenhum QTC resolvido" : "Nenhum QTC em aberto"}</b><small>Os alertas publicados pelos operadores aparecerão aqui.</small></section> : <><div className="alert-groups">{groups.map((group) => <section className="alert-group" key={group.priority}><div className="alert-group-heading"><h2>{ALERT_PRIORITY_LABEL[group.priority]}</h2><span>{group.items.length} QTC{group.items.length === 1 ? "" : "s"}</span></div>{group.items.map((alert) => <article className={`alert-card alert-summary-card ${alert.status}`} key={alert.id} role="button" tabIndex={0} onClick={() => setSelectedAlert(alert)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedAlert(alert); } }}><div className="alert-card-head"><div><span className={`priority-chip ${alert.priority}`}>{ALERT_PRIORITY_LABEL[alert.priority]}</span><h3>{alert.categoryLabel}</h3></div></div><p className="alert-summary-description">{alert.description.length > 150 ? `${alert.description.slice(0, 150).trim()}…` : alert.description}</p><div className="alert-summary-meta"><span>Ocorrência: <b>{formatDate(alert.occurredAt)}</b></span><span>{alert.neighborhood ? `${alert.municipality} · ${alert.neighborhood}` : alert.municipality}</span></div></article>)}</section>)}</div><div className="alert-pagination"><button type="button" disabled={alertPage <= 1} onClick={() => setAlertPage((value) => Math.max(1, value - 1))}>Anterior</button><span>Página {Math.min(alertPage, alertPageCount)} de {alertPageCount} · {alerts.length} QTCs</span><button type="button" disabled={alertPage >= alertPageCount} onClick={() => setAlertPage((value) => Math.min(alertPageCount, value + 1))}>Próxima</button></div></>)}
    {!showCreate && <button className="floating-alert" onClick={() => { setShowCreate(true); setNotice(""); }}><NavIcon name="plus" /><span>Novo QTC</span></button>}
  </div>;
}

function AlertDetailsPage({ alert, saving, canDelete, onBack, onChangeStatus, onDelete }: { alert: AlertRecord; saving: boolean; canDelete: boolean; onBack: () => void; onChangeStatus: () => void; onDelete: () => void }) {
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  return <section className="alert-detail-page"><button type="button" className="alert-back" onClick={onBack}>‹ Voltar para os alertas</button><div className="alert-detail-hero"><div><span className={`priority-chip ${alert.priority}`}>{ALERT_PRIORITY_LABEL[alert.priority]}</span><h2>{alert.categoryLabel}</h2><p>{alert.municipality}{alert.neighborhood ? ` · ${alert.neighborhood}` : ""}</p></div><span className={`alert-status ${alert.status}`}>{alert.status === "resolved" ? "Resolvido" : "Em aberto"}</span></div><div className="alert-detail-sections"><section><h3>Ocorrência</h3><dl><div><dt>Data e hora</dt><dd>{formatDate(alert.occurredAt)}</dd></div><div><dt>Descrição</dt><dd className="preserve-lines">{alert.description}</dd></div></dl></section>{(alert.peopleInfo || alert.vehicleInfo) && <section><h3>Envolvidos</h3><dl>{alert.peopleInfo && <div><dt>Pessoas</dt><dd className="preserve-lines">{alert.peopleInfo}</dd></div>}{alert.vehicleInfo && <div><dt>Veículo</dt><dd className="preserve-lines">{alert.vehicleInfo}</dd></div>}</dl></section>}{alert.locationLink && <section><h3>Localização ou rastreio</h3><a className="alert-detail-link" href={alert.locationLink} target="_blank" rel="noreferrer">↗ Abrir link informado</a></section>}{alert.images.length > 0 && <section><h3>Imagens</h3><div className="alert-detail-images">{alert.images.map((image) => <figure key={image.id}><img src={image.url} alt={image.name} onClick={() => setLightbox({ src: image.url, alt: image.name })} /><figcaption>{image.name}</figcaption></figure>)}</div></section>}<section><h3>Registro</h3><dl><div><dt>Enviado por</dt><dd>{alert.createdByName}</dd></div><div><dt>Data e hora do envio</dt><dd>{formatDate(alert.createdAt)}</dd></div>{alert.status === "resolved" && <div><dt>Resolvido por</dt><dd>{alert.resolvedByName ? `${alert.resolvedByName} · ${formatDate(alert.resolvedAt)}` : "Não informado"}</dd></div>}</dl></section></div><button type="button" className={alert.status === "resolved" ? "secondary alert-detail-action" : "primary alert-detail-action"} disabled={saving} onClick={onChangeStatus}>{alert.status === "resolved" ? "Reabrir QTC" : "Marcar como resolvido"}</button>{canDelete && <button type="button" className="danger-outline alert-delete-action" disabled={saving} onClick={onDelete}>Apagar QTC</button>}{lightbox && <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}</section>;
}

function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="Imagem ampliada" onClick={(event) => { event.stopPropagation(); onClose(); }}><button type="button" className="image-lightbox-close" aria-label="Fechar imagem">×</button><img src={src} alt={alt} onClick={(event) => event.stopPropagation()} /></div>;
}

function ConfirmModal({ title, message, confirmLabel, onCancel, onConfirm }: { title: string; message: string; confirmLabel: string; onCancel: () => void; onConfirm: () => Promise<void> | void }) {
  const [working, setWorking] = useState(false);
  async function confirm() {
    setWorking(true);
    try { await onConfirm(); } finally { setWorking(false); }
  }
  return <div className="modal-backdrop confirm-backdrop" onClick={(event) => { event.stopPropagation(); onCancel(); }}><section className="confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(event) => event.stopPropagation()}><div className="confirm-icon" aria-hidden="true">!</div><h2 id="confirm-title">{title}</h2><p>{message}</p><div className="confirm-actions"><button type="button" className="secondary" disabled={working} onClick={onCancel}>Cancelar</button><button type="button" className="danger-button" disabled={working} onClick={() => void confirm()}>{working ? "Aguarde…" : confirmLabel}</button></div></section></div>;
}

function AlertFormSection({ title, subtitle, open, onToggle, children }: { title: string; subtitle: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return <section className={`alert-form-section ${open ? "open" : ""}`}><button type="button" className="alert-section-toggle" aria-expanded={open} onClick={onToggle}><span><b>{title}</b><small>{subtitle}</small></span><strong aria-hidden="true">{open ? "−" : "+"}</strong></button>{open && <div className="alert-section-content">{children}</div>}</section>;
}

function NavIcon({ name }: { name: "search" | "plus" | "account" }) {
  if (name === "search") return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" /></svg>;
  if (name === "plus") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4.8 21c.7-4 3.1-6 7.2-6s6.5 2 7.2 6" /></svg>;
}

function FormSection({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return <section className={`form-section collapsible-form-section ${open ? "open" : ""}`}><button type="button" className="form-section-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}><span><b>{title}</b><small>{subtitle}</small></span><strong aria-hidden="true">{open ? "−" : "+"}</strong></button><div className={`form-section-content ${open ? "" : "collapsed"}`}>{children}</div></section>;
}

function PhotoInput({ name, label, required, multiple }: { name: string; label: string; required?: boolean; multiple?: boolean }) {
  const [previews, setPreviews] = useState<string[]>([]);
  useEffect(() => () => previews.forEach((url) => URL.revokeObjectURL(url)), [previews]);
  function selected(event: ChangeEvent<HTMLInputElement>) {
    previews.forEach((url) => URL.revokeObjectURL(url));
    const files = Array.from(event.target.files ?? []);
    setPreviews(files.map((file) => URL.createObjectURL(file)));
    if (files.length) {
      const dateInput = event.currentTarget.closest(".photo-record")?.querySelector<HTMLInputElement>('input[type="date"]');
      if (dateInput) dateInput.value = currentBrasiliaDate();
    }
  }
  return <label className={`photo-input ${previews.length ? "has-preview" : ""}`}>
    {previews.length ? <div className="selected-previews">{previews.map((url, index) => <img key={url} src={url} alt={`Prévia ${index + 1} de ${label}`} />)}</div> : <span>▧</span>}
    <b>{label}{required ? " *" : ""}</b><small>{previews.length ? `${previews.length} foto(s) selecionada(s)` : "Galeria, arquivos ou câmera"}</small>
    <input name={name} type="file" accept="image/jpeg,image/png,image/webp" required={required} multiple={multiple} onChange={selected} />
  </label>;
}

type AdminRow = { id: number | string; name?: string; warName?: string; rank?: string; email?: string; role?: string; invitedBy?: string | null; cpf?: string; createdBy?: string | null; createdByName?: string | null; createdAt: string };
function AdminList({ kind }: { kind: "operators" | "records" }) {
  const [rows, setRows] = useState<AdminRow[]>([]); const [page, setPage] = useState(1); const [total, setTotal] = useState(0); const [loading, setLoading] = useState(true);
  const [confirmRow, setConfirmRow] = useState<AdminRow | null>(null);
  async function load() { setLoading(true); const response = await apiFetch(`/api/admin/${kind}?page=${page}`); const data = await response.json() as { rows?: AdminRow[]; total?: number }; setRows(data.rows ?? []); setTotal(data.total ?? 0); setLoading(false); }
  useEffect(() => {
    let active = true;
    apiFetch(`/api/admin/${kind}?page=${page}`).then((response) => response.json()).then((data: { rows?: AdminRow[]; total?: number }) => {
      if (!active) return;
      setRows(data.rows ?? []); setTotal(data.total ?? 0); setLoading(false);
    }).catch(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, kind]);
  async function remove(row: AdminRow) {
    const response = kind === "operators" ? await apiFetch(`/api/admin/operators?id=${encodeURIComponent(String(row.id))}`, { method: "DELETE" }) : await apiFetch(`/api/people/${row.id}`, { method: "DELETE" });
    if (response.ok) await load();
  }
  const pages = Math.max(1, Math.ceil(total / 10));
  return <section className="panel admin-list"><div className="panel-title"><h2>{kind === "operators" ? "Contas cadastradas" : "Pessoas cadastradas"}</h2><span>{total} no total</span></div>
    {loading ? <p>Carregando…</p> : <div className="admin-rows">{rows.map((row) => {
      const displayName = kind === "operators"
        ? [rankLabel(row.rank), row.warName || row.name].filter((value) => Boolean(value && value.trim())).join(" ") || "Nome não informado"
        : row.name || "Nome não informado";
      const createdBy = row.createdByName || row.createdBy || "não informado";
      return <article key={row.id}><div><b>{displayName}</b><small>{kind === "operators" ? `${row.role === "admin" ? "Administrador" : "Operador"}${row.email ? ` · ${row.email}` : ""}${row.invitedBy ? ` · convidado por ${row.invitedBy}` : ""}` : `${maskCpf(row.cpf ?? "")} · cadastrado por ${createdBy}`}</small></div>{!(kind === "operators" && row.role === "admin") && <button onClick={() => setConfirmRow(row)}>Apagar</button>}</article>;
    })}</div>}
    <div className="pagination"><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Anterior</button><span>{page} de {pages}</span><button disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>Próxima</button></div>
    {confirmRow && <ConfirmModal title={`Apagar ${kind === "operators" ? "operador" : "cadastro"}?`} message={`Esta ação removerá ${confirmRow.name || "este registro"} permanentemente.`} confirmLabel="Apagar" onCancel={() => setConfirmRow(null)} onConfirm={async () => { const row = confirmRow; setConfirmRow(null); await remove(row); }} />}
  </section>;
}

function PersonList({ people, onSelect }: { people: Person[]; onSelect: (person: Person) => void }) {
  if (!people.length) return <div className="empty"><i>⌕</i><b>Nenhum registro para exibir</b><span>Faça uma consulta ou inclua um novo cadastro.</span></div>;
  return <div className="person-list">{people.map((person) => {
    const face = person.media?.find((item) => item.kind === "face" || item.kind === "face_front" || item.kind === "face_profile");
    return <button key={person.id} onClick={() => onSelect(person)}>
      {face ? <img className="list-photo" src={face.url} alt="" /> : <span className="list-avatar">{initials(person.fullName)}</span>}
      <span className="person-name"><b>{person.fullName}</b><small>{person.nickname ? `“${person.nickname}” · ` : ""}{maskCpf(person.cpf)}</small><em>Nascimento: {formatDate(person.birthDate)} · {custodyStatusLabel[person.custodyStatus ?? "free"]} · {person.approachCount || 0} abordagem(ns)</em><span className="person-alerts">{person.factionName && <strong className="person-alert faction-alert">⚠ Faccionado: {person.factionName}</strong>}{person.seizedObjects?.length > 0 && <strong className="person-alert object-alert">⚠ Possui objeto apreendido</strong>}{person.notes?.trim() && <strong className="person-alert observation-alert">⚠ Possui observação</strong>}</span></span>
      <span className={`badge ${person.status}`}>{statusLabel[person.status]}</span><span className="arrow">›</span>
    </button>;
  })}</div>;
}

function PersonModal({ person, onClose, onApproach, onEdit, onDelete }: { person: Person; onClose: () => void; onApproach: (person: Person) => void; onEdit: (person: Person) => void; onDelete: (person: Person) => void }) {
  const face = person.media?.find((item) => item.kind === "face" || item.kind === "face_front" || item.kind === "face_profile");
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="person-modal person-sheet" role="dialog" aria-modal="true" aria-labelledby="person-title" onClick={(event) => event.stopPropagation()}>
        <button className="close" onClick={onClose} aria-label="Fechar">×</button>
        <div className="person-hero">
          {face ? <img src={face.url} alt={`Foto frontal de ${person.fullName}`} className="zoomable-image" onClick={() => setLightbox({ src: face.url, alt: `Foto frontal de ${person.fullName}` })} /> : <span>{initials(person.fullName)}</span>}
          <div><small>CADASTRO Nº {person.id}</small><h2 id="person-title">{person.fullName}</h2>{person.nickname && <p>Alcunha: <b>{person.nickname}</b></p>}<b className={`badge ${person.status}`}>{statusLabel[person.status]}</b></div>
        </div>
        <div className="sheet-actions">
          <button className="secondary" onClick={() => onEdit(person)}>✎ Editar ficha</button>
          <button className="primary" onClick={() => onApproach(person)}>⌖ Registrar abordagem</button>
        </div>
        <button className="delete-person" onClick={() => setConfirmDelete(true)}>Apagar cadastro</button>
        <dl>
          <div><dt>CPF</dt><dd>{maskCpf(person.cpf)}</dd></div>
          <div><dt>Nascimento</dt><dd>{formatDate(person.birthDate)}</dd></div>
          <div><dt>Filiação</dt><dd>{person.motherName || "Não informada"}</dd></div>
          <div><dt>Referência</dt><dd>{[person.city, person.state].filter(Boolean).join(" / ") || "Não informada"}</dd></div>
          <div><dt>Faccionado</dt><dd>{person.factionName || "Não"}</dd></div>
          <div><dt>Custódia</dt><dd>{custodyStatusLabel[person.custodyStatus ?? "free"]}</dd></div>
        </dl>

        {person.media?.length > 0 && <SheetSection title="Imagens de identificação" count={person.media.length}>
          <div className="media-gallery">{person.media.map((item) => <figure key={item.id}><img src={item.url} alt={mediaLabel[item.kind]} onClick={() => setLightbox({ src: item.url, alt: mediaLabel[item.kind] })} /><figcaption>{mediaLabel[item.kind]}<small>{item.capturedAt ? formatDate(item.capturedAt) : "Data não informada"}</small></figcaption></figure>)}</div>
        </SheetSection>}

        <SheetSection title="Endereços" count={person.addresses?.length || 0}>
          {person.addresses?.length ? <div className="detail-list">{person.addresses.map((address, index) => <article key={address.id ?? index}><b>{address.label}</b><span>{address.address}</span><small>{[address.city, address.state].filter(Boolean).join(" / ")}</small>{address.notes && <em>{address.notes}</em>}</article>)}</div> : <EmptyDetail text="Nenhum endereço cadastrado." />}
        </SheetSection>

        <SheetSection title="Abordagens" count={person.approachCount || 0}>
          {person.approaches?.length ? <div className="detail-list">{person.approaches.map((approach) => <article key={approach.id}><b>{formatDate(approach.occurredAt)}</b><span>{approach.locationLabel || "Localização geográfica registrada"}</span><a href={`https://www.google.com/maps?q=${approach.latitude},${approach.longitude}`} target="_blank" rel="noreferrer">Abrir localização no mapa ↗</a>{approach.notes && <small>{approach.notes}</small>}</article>)}</div> : <EmptyDetail text="Nenhuma abordagem registrada." />}
        </SheetSection>

        <SheetSection title="Objetos apreendidos" count={person.seizedObjects?.length || 0}>
          {person.seizedObjects?.length ? <div className="detail-list">{person.seizedObjects.map((item, index) => <article key={item.id ?? index}><b>{item.description}</b><span>{item.seizedAt ? formatDate(item.seizedAt) : "Data não informada"}</span></article>)}</div> : <EmptyDetail text="Nenhum objeto apreendido vinculado." />}
        </SheetSection>

        {person.notes && <div className="note"><b>Observação operacional</b><p>{person.notes}</p></div>}
        <p className="audit-line">▣ Visualização registrada na trilha de auditoria.</p>
      </section>{lightbox && <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}{confirmDelete && <ConfirmModal title="Apagar cadastro?" message={`O cadastro de ${person.fullName} e suas imagens serão removidos permanentemente.`} confirmLabel="Apagar cadastro" onCancel={() => setConfirmDelete(false)} onConfirm={() => onDelete(person)} />}
    </div>
  );
}

function EditPersonModal({
  person,
  factions,
  loading,
  onClose,
  onLoading,
  onMessage,
  onUpdated,
}: {
  person: Person;
  factions: Faction[];
  loading: boolean;
  onClose: () => void;
  onLoading: (value: boolean) => void;
  onMessage: (value: string) => void;
  onUpdated: (person: Person) => void;
}) {
  const [editAddresses, setEditAddresses] = useState<Address[]>(
    person.addresses?.length ? person.addresses.map((item) => ({ ...item })) : [blankAddress()],
  );
  const [editObjects, setEditObjects] = useState<SeizedObject[]>(
    person.seizedObjects?.map((item) => ({ ...item })) ?? [],
  );
  const [editFactionAffiliated, setEditFactionAffiliated] = useState(Boolean(person.factionId));
  const [editFactionChoice, setEditFactionChoice] = useState(person.factionId ? String(person.factionId) : "");
  const [editNewFactionName, setEditNewFactionName] = useState("");
  const [mediaItems, setMediaItems] = useState<Media[]>(person.media ?? []);
  const [removedMediaIds, setRemovedMediaIds] = useState<number[]>([]);
  const [mediaToRemove, setMediaToRemove] = useState<Media | null>(null);
  const [editNotice, setEditNotice] = useState("");

  async function submitEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onLoading(true);
    onMessage("");
    setEditNotice("");
    try {
      const form = new FormData(event.currentTarget);
      const fullName = String(form.get("fullName") ?? "").trim();
      const cpfDigits = String(form.get("cpf") ?? "").replace(/\D/g, "");
      if (fullName.length < 3) throw new Error("Informe o nome completo.");
      if (cpfDigits.length !== 11) throw new Error("Informe um CPF válido com 11 dígitos.");
      if (editFactionAffiliated && !editFactionChoice) throw new Error("Selecione uma facção ou escolha adicionar uma nova.");
      if (editFactionAffiliated && editFactionChoice === "new" && editNewFactionName.trim().length < 2) throw new Error("Informe o nome da nova facção.");
      const editFaceFiles = form.getAll("facePhotos").filter((item): item is File => item instanceof File && item.size > 0);
      const editTattooFiles = form.getAll("tattoos").filter((item): item is File => item instanceof File && item.size > 0);
      // A edição aceita qualquer imagem sem exigir detecção facial.
      const editTattooHashes = await Promise.all(editTattooFiles.map(safeVisualSignature));
      form.set("facePhotoHashes", JSON.stringify([]));
      form.set("faceEmbeddings", JSON.stringify([]));
      form.set("tattooHashes", JSON.stringify(editTattooHashes));
      form.set("removeMediaIds", JSON.stringify(removedMediaIds));
      form.set("addresses", JSON.stringify(editAddresses.filter((item) => item.address.trim())));
      form.set("seizedObjects", JSON.stringify(editObjects.filter((item) => item.description.trim())));
      form.set("factionAffiliated", editFactionAffiliated ? "yes" : "no");
      if (editFactionAffiliated) {
        if (editFactionChoice === "new") form.set("newFactionName", editNewFactionName);
        else form.set("factionId", editFactionChoice);
      }
      const response = await withTimeout(
        apiFetch(`/api/people/${person.id}`, { method: "PUT", body: form }),
        30000,
        "A atualização demorou demais. Verifique sua conexão e tente novamente.",
      );
      let data: { person?: Person; error?: string } = {};
      try { data = await response.json() as { person?: Person; error?: string }; } catch { /* resposta inválida */ }
      if (!response.ok || !data.person) {
        const errorMessage = data.error ?? "Não foi possível atualizar o cadastro.";
        setEditNotice(errorMessage);
        onMessage(errorMessage);
        return;
      }
      onUpdated(data.person);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Não foi possível atualizar o cadastro.";
      setEditNotice(errorMessage);
      onMessage(errorMessage);
    } finally {
      onLoading(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="person-modal person-sheet edit-sheet" noValidate onSubmit={submitEdit} onClick={(event) => event.stopPropagation()}>
        <button type="button" className="close" onClick={onClose} aria-label="Fechar">×</button>
        <small className="eyebrow">EDIÇÃO AUDITADA</small>
        <h2>Editar ficha nº {person.id}</h2>
        <p className="edit-intro">Atualize ou complemente os dados. O histórico de abordagens é preservado e não pode ser sobrescrito por este formulário.</p>

        <FormSection title="Identificação" subtitle="Dados civis e operacionais">
          <div className="form-grid">
            <label className="wide">Nome completo *<input name="fullName" required minLength={3} defaultValue={person.fullName} /></label>
            <label>CPF *<input name="cpf" required inputMode="numeric" defaultValue={maskCpf(person.cpf)} /></label>
            <label>Alcunha<input name="nickname" defaultValue={person.nickname ?? ""} /></label>
            <label>Data de nascimento<input name="birthDate" type="date" defaultValue={person.birthDate ?? ""} /></label>
            <label>Nome da mãe<input name="motherName" defaultValue={person.motherName ?? ""} /></label>
            <label>Cidade de referência<input name="city" defaultValue={person.city ?? ""} /></label>
            <label>UF<select name="state" defaultValue={person.state ?? "PB"}><option>PB</option><option>RN</option><option>PE</option><option>CE</option></select></label>
            <label>Situação<select name="status" defaultValue={person.status}><option value="alive">Vivo</option><option value="dead">Morto</option></select></label><label>Custódia<select name="custodyStatus" defaultValue={person.custodyStatus ?? "free"}><option value="free">Em liberdade</option><option value="detained">Preso</option></select></label>
          </div>
          <div className="faction-fields">
            <label>Faccionado?<select value={editFactionAffiliated ? "yes" : "no"} onChange={(event) => { const enabled = event.target.value === "yes"; setEditFactionAffiliated(enabled); if (!enabled) { setEditFactionChoice(""); setEditNewFactionName(""); } }}><option value="no">Não</option><option value="yes">Sim</option></select></label>
            {editFactionAffiliated && <label>Facção<select value={editFactionChoice} onChange={(event) => setEditFactionChoice(event.target.value)} required><option value="">Selecione</option>{factions.map((faction) => <option key={faction.id} value={faction.id}>{faction.name}</option>)}<option value="new">＋ Adicionar nova facção</option></select></label>}
            {editFactionAffiliated && editFactionChoice === "new" && <label className="wide">Nome da nova facção<input value={editNewFactionName} onChange={(event) => setEditNewFactionName(event.target.value)} required minLength={2} /></label>}
          </div>
        </FormSection>

        <FormSection title="Imagens" subtitle="Novas fotos são adicionadas ao histórico sem substituir as anteriores">
          {mediaItems.length > 0 && (
            <div className="existing-media">
              {mediaItems.map((item) => (
                <figure key={item.id}>
                  <img src={item.url} alt={mediaLabel[item.kind]} />
                  <figcaption>{mediaLabel[item.kind]}<small>{item.capturedAt ? formatDate(item.capturedAt) : "Data não informada"}</small><button type="button" className="remove-media" onClick={() => setMediaToRemove(item)}>Apagar foto</button></figcaption>
                </figure>
              ))}
            </div>
          )}
          <div className="photo-grid compact-photos">
            <div className="photo-record"><PhotoInput name="facePhotos" label="Adicionar fotos do rosto" multiple /><label>Data das fotos<input name="facePhotoDate" type="date" defaultValue={currentBrasiliaDate()} /></label></div>
            <div className="photo-record"><PhotoInput name="tattoos" label="Adicionar tatuagens" multiple /><label>Data das fotos<input name="tattooPhotoDate" type="date" defaultValue={currentBrasiliaDate()} /></label></div>
          </div>
        </FormSection>

        <FormSection title="Endereços" subtitle="Adicione, corrija ou remova vínculos">
          <div className="repeat-list">
            {editAddresses.map((address, index) => (
              <div className="repeat-card" key={address.id ?? `new-${index}`}>
                <div className="repeat-head">
                  <b>Endereço {index + 1}</b>
                  <button type="button" onClick={() => setEditAddresses((items) => items.filter((_, itemIndex) => itemIndex !== index))}>Remover</button>
                </div>
                <div className="form-grid">
                  <label>Tipo<input value={address.label} onChange={(event) => setEditAddresses((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))} /></label>
                  <label className="wide">Logradouro e número<input value={address.address} onChange={(event) => setEditAddresses((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, address: event.target.value } : item))} /></label>
                  <label>Cidade<input value={address.city} onChange={(event) => setEditAddresses((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, city: event.target.value } : item))} /></label>
                  <label>UF<input value={address.state} maxLength={2} onChange={(event) => setEditAddresses((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, state: event.target.value.toUpperCase() } : item))} /></label>
                  <label className="wide">Observação do endereço<input value={address.notes ?? ""} onChange={(event) => setEditAddresses((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, notes: event.target.value } : item))} placeholder="Ex.: endereço da mãe" /></label>
                </div>
              </div>
            ))}
            <button type="button" className="add-row" onClick={() => setEditAddresses((items) => [...items, blankAddress()])}>＋ Adicionar endereço</button>
          </div>
        </FormSection>

        <FormSection title="Objetos apreendidos" subtitle="Mantenha somente vínculos documentados">
          <div className="repeat-list">
            {editObjects.map((item, index) => (
              <div className="repeat-card" key={item.id ?? `new-${index}`}>
                <div className="repeat-head">
                  <b>Registro {index + 1}</b>
                  <button type="button" onClick={() => setEditObjects((items) => items.filter((_, itemIndex) => itemIndex !== index))}>Remover</button>
                </div>
                <div className="form-grid">
                  <label className="wide">Observação<textarea rows={3} value={item.description} onChange={(event) => setEditObjects((items) => items.map((current, itemIndex) => itemIndex === index ? { ...current, description: event.target.value } : current))} placeholder="Descreva os objetos apreendidos e as informações relevantes" /></label>
                  <label>Data da apreensão<input type="date" value={item.seizedAt ?? ""} onChange={(event) => setEditObjects((items) => items.map((current, itemIndex) => itemIndex === index ? { ...current, seizedAt: event.target.value } : current))} /></label>
                </div>
              </div>
            ))}
            <button type="button" className="add-row" onClick={() => setEditObjects((items) => [...items, blankObject()])}>＋ Adicionar objeto</button>
          </div>
        </FormSection>

        <label className="wide notes-field">Observação geral<textarea name="notes" rows={4} defaultValue={person.notes ?? ""} /></label>
        {editNotice && <div className="feedback modal-feedback" role="alert">{editNotice}</div>}
        <div className="form-actions edit-actions">
          <button type="button" className="secondary" onClick={onClose}>Cancelar</button>
          <button type="submit" className="primary" disabled={loading}>{loading ? "Salvando…" : "Salvar alterações"}</button>
        </div>
      </form>{mediaToRemove && <ConfirmModal title="Apagar esta foto?" message="A foto será removida do cadastro quando você salvar as alterações." confirmLabel="Apagar foto" onCancel={() => setMediaToRemove(null)} onConfirm={() => { setRemovedMediaIds((ids) => [...ids, mediaToRemove.id]); setMediaItems((items) => items.filter((item) => item.id !== mediaToRemove.id)); setMediaToRemove(null); }} />}
    </div>
  );
}

function SheetSection({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return <section className="sheet-section"><div className="sheet-title"><h3>{title}</h3><span>{count}</span></div>{children}</section>;
}

function EmptyDetail({ text }: { text: string }) {
  return <p className="empty-detail">{text}</p>;
}

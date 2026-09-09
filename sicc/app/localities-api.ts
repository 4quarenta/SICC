import { apiFetch } from "./api-client";
import { LOCALITIES } from "./localities";

export type LocalityState = { uf: string; name: string };
export type LocalityCity = { id: number; name: string; uf: string };
export type LocalityNeighborhood = { id: number | null; name: string };

const IBGE_API = "https://servicodados.ibge.gov.br/api/v1/localidades";
const stateCache = new Map<string, LocalityState[]>();
const cityCache = new Map<string, LocalityCity[]>();
const neighborhoodCache = new Map<number, LocalityNeighborhood[]>();

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function cached<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(`sicc:localities:${key}`);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

function store<T>(key: string, value: T) {
  try { window.localStorage.setItem(`sicc:localities:${key}`, JSON.stringify(value)); } catch { /* cache is optional */ }
}

export async function loadStates(): Promise<LocalityState[]> {
  if (stateCache.has("all")) return stateCache.get("all") ?? [];
  const saved = cached<LocalityState[]>("states");
  if (saved?.length) { stateCache.set("all", saved); return saved; }
  try {
    const response = await fetch(`${IBGE_API}/estados?orderBy=nome`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("IBGE_STATES_FAILED");
    const rows = await response.json() as Array<{ sigla: string; nome: string }>;
    const states = rows.map((row) => ({ uf: row.sigla, name: row.nome }));
    stateCache.set("all", states); store("states", states);
    return states;
  } catch {
    const fallback: LocalityState[] = [
      ["AC", "Acre"], ["AL", "Alagoas"], ["AP", "Amapá"], ["AM", "Amazonas"], ["BA", "Bahia"], ["CE", "Ceará"], ["DF", "Distrito Federal"], ["ES", "Espírito Santo"], ["GO", "Goiás"], ["MA", "Maranhão"], ["MT", "Mato Grosso"], ["MS", "Mato Grosso do Sul"], ["MG", "Minas Gerais"], ["PA", "Pará"], ["PB", "Paraíba"], ["PR", "Paraná"], ["PE", "Pernambuco"], ["PI", "Piauí"], ["RJ", "Rio de Janeiro"], ["RN", "Rio Grande do Norte"], ["RS", "Rio Grande do Sul"], ["RO", "Rondônia"], ["RR", "Roraima"], ["SC", "Santa Catarina"], ["SP", "São Paulo"], ["SE", "Sergipe"], ["TO", "Tocantins"],
    ].map(([uf, name]) => ({ uf, name }));
    stateCache.set("all", fallback);
    return fallback;
  }
}

export async function loadCities(uf: string): Promise<LocalityCity[]> {
  const cleanUf = uf.trim().toUpperCase();
  if (!cleanUf) return [];
  if (cityCache.has(cleanUf)) return cityCache.get(cleanUf) ?? [];
  const saved = cached<LocalityCity[]>(`cities:${cleanUf}`);
  if (saved?.length) { cityCache.set(cleanUf, saved); return saved; }
  try {
    const response = await fetch(`${IBGE_API}/estados/${encodeURIComponent(cleanUf)}/municipios?orderBy=nome`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("IBGE_CITIES_FAILED");
    const rows = await response.json() as Array<{ id: number; nome: string }>;
    const cities = rows.map((row) => ({ id: Number(row.id), name: row.nome, uf: cleanUf }));
    cityCache.set(cleanUf, cities); store(`cities:${cleanUf}`, cities);
    return cities;
  } catch {
    const fallback = Object.entries(LOCALITIES)
      .filter(([name]) => ({
        "João Pessoa": "PB", "Campina Grande": "PB", "Santa Rita": "PB", Bayeux: "PB", Cabedelo: "PB",
        Natal: "RN", Parnamirim: "RN", Mossoró: "RN", "São Gonçalo do Amarante": "RN", Macaíba: "RN",
      } as Record<string, string>)[name] === cleanUf)
      .map(([name], index) => ({ id: -(index + 1), name, uf: cleanUf }));
    cityCache.set(cleanUf, fallback);
    return fallback;
  }
}

export async function loadNeighborhoods(city: LocalityCity | null): Promise<LocalityNeighborhood[]> {
  if (!city) return [];
  if (neighborhoodCache.has(city.id)) return neighborhoodCache.get(city.id) ?? [];
  const saved = city.id > 0 ? cached<LocalityNeighborhood[]>(`neighborhoods:${city.id}`) : null;
  if (saved?.length) { neighborhoodCache.set(city.id, saved); return saved; }
  try {
    const response = await apiFetch(`/api/localities/neighborhoods?ibgeCode=${encodeURIComponent(String(city.id))}&city=${encodeURIComponent(city.name)}&state=${encodeURIComponent(city.uf)}`, { cache: "force-cache" });
    if (response.ok) {
      const data = await response.json() as { neighborhoods?: Array<{ id?: number | null; name?: string }>; };
      const neighborhoods = (data.neighborhoods ?? []).map((item) => ({ id: item.id ?? null, name: String(item.name ?? "").trim() })).filter((item) => item.name).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
      if (neighborhoods.length) {
        neighborhoodCache.set(city.id, neighborhoods);
        if (city.id > 0) store(`neighborhoods:${city.id}`, neighborhoods);
        return neighborhoods;
      }
    }
  } catch {
    // The QTC form remains usable if the optional neighborhood provider is down.
  }
  const fallback = (LOCALITIES[city.name] ?? []).map((name, index) => ({ id: -(index + 1), name })).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  neighborhoodCache.set(city.id, fallback);
  return fallback;
}

export function findCity(cities: LocalityCity[], name: string) {
  const target = normalize(name);
  return cities.find((city) => normalize(city.name) === target) ?? null;
}

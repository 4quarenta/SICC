export type InfosegParseResult = {
  fullName: string;
  motherName: string;
  nickname: string;
  cpf: string;
  birthDate: string;
  city: string;
  state: string;
  address: string;
  notes: string;
  confidence: number;
  recognizedFields: string[];
};

type LabelInfo = {
  raw: string;
  key: string;
  value: string;
};

type Entry = {
  index: number;
  raw: string;
  value: string;
  label: LabelInfo | null;
  used: boolean;
};

const ADDRESS_PREFIX = /^(rua|r\.?|avenida|av\.?|travessa|tv\.?|rodovia|rodo\.?|estrada|sítio|sitio|fazenda|praça|praca|alameda|loteamento|bairro|mora\b|reside\b|domicilia\b)/i;
const DATE_PATTERN = /\b(\d{2})[\/-](\d{2})[\/-](\d{4})\b/;
const CITY_STATE_PATTERN = /^(.+?)\s*(?:-|\u2013|\u2014)\s*([A-Za-z]{2})$/;
const CPF_PATTERN = /(?:^|\D)(\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2})(?:$|\D)/;

function clean(value: string) {
  return value.replace(/\u200B/g, "").replace(/\s+/g, " ").trim();
}

function stripLeadingMarks(value: string) {
  return clean(value).replace(/^[^\p{L}\p{N}]*/u, "").trim();
}

function normalizeLabel(value: string) {
  return stripLeadingMarks(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function withoutLabel(value: string) {
  return clean(value).replace(/^(?:obs(?:erva[cç][aã]o)?|observa[cç][aã]o|informa[cç][aã]o)\s*:\s*/i, "").trim();
}

function isLikelyName(value: string) {
  const words = stripLeadingMarks(value).split(" ").filter(Boolean);
  return words.length >= 2 && words.every((word) => /^[A-Za-zÀ-ÿ'’-]+$/.test(word));
}

function normalizeCpf(value: string) {
  return value.replace(/\D/g, "").slice(0, 11);
}

function parseDate(value: string) {
  const match = value.match(DATE_PATTERN);
  return match ? match[3] + "-" + match[2] + "-" + match[1] : "";
}

function extractLabel(raw: string): LabelInfo | null {
  const normalized = stripLeadingMarks(raw);
  const match = normalized.match(/^([^:]{1,45}):\s*(.*)$/);
  if (!match) return null;
  return {
    raw: clean(match[1]),
    key: normalizeLabel(match[1]),
    value: clean(match[2]),
  };
}

function labelKind(key: string) {
  if (/^(nome|nome completo)$/.test(key)) return "fullName";
  if (/^(vulgo|alcunha|apelido)$/.test(key)) return "nickname";
  if (/^(filiacao|filiacao 1|mae|nome da mae)$/.test(key)) return "motherName";
  if (key === "cpf") return "cpf";
  if (/^(data de nascimento|data nascimento|nascimento|dt nascimento)$/.test(key)) return "birthDate";
  if (/^(endereco|residencia|moradia)$/.test(key)) return "address";
  if (/^(cidade|municipio|município)$/.test(key)) return "city";
  if (/^(uf|estado)$/.test(key)) return "state";
  if (/^(observacao|observacoes|obs|informacao|informacoes)$/.test(key)) return "notes";
  return "metadata";
}

function extractCityState(value: string) {
  const match = stripLeadingMarks(value).match(CITY_STATE_PATTERN);
  return match ? { city: clean(match[1]), state: match[2].toUpperCase() } : null;
}

function addNote(notes: string[], value: string) {
  const note = withoutLabel(value);
  if (note && !notes.includes(note)) notes.push(note);
}

export function parseInfosegText(rawText: string): InfosegParseResult {
  const sourceLines = rawText
    .split(/\r?\n/)
    .map((line) => clean(line))
    .filter(Boolean);

  const entries: Entry[] = [];
  let pendingLabel: LabelInfo | null = null;

  sourceLines.forEach((raw, index) => {
    const directLabel = extractLabel(raw);
    if (directLabel && !directLabel.value) {
      pendingLabel = directLabel;
      return;
    }
    if (pendingLabel && !directLabel) {
      entries.push({ index, raw, value: stripLeadingMarks(raw), label: pendingLabel, used: false });
      pendingLabel = null;
      return;
    }
    entries.push({
      index,
      raw,
      value: directLabel?.value || stripLeadingMarks(raw),
      label: directLabel,
      used: false,
    });
  });

  if (pendingLabel) {
    entries.push({ index: sourceLines.length, raw: pendingLabel.raw, value: "", label: pendingLabel, used: false });
  }

  const recognized = new Set<string>();
  const notes: string[] = [];
  const result: InfosegParseResult = {
    fullName: "",
    motherName: "",
    nickname: "",
    cpf: "",
    birthDate: "",
    city: "",
    state: "PB",
    address: "",
    notes: "",
    confidence: 0,
    recognizedFields: [],
  };

  for (const entry of entries) {
    if (!entry.label || !entry.value) continue;
    const kind = labelKind(entry.label.key);
    const value = entry.value;
    if (kind === "fullName") {
      result.fullName = value;
      entry.used = true;
      recognized.add("nome");
    } else if (kind === "motherName") {
      result.motherName = value;
      entry.used = true;
      recognized.add("nome da mãe");
    } else if (kind === "nickname") {
      result.nickname = value;
      entry.used = true;
      recognized.add("alcunha");
    } else if (kind === "cpf") {
      result.cpf = normalizeCpf(value);
      entry.used = true;
      if (result.cpf) recognized.add("CPF");
    } else if (kind === "birthDate") {
      result.birthDate = parseDate(value);
      entry.used = true;
      if (result.birthDate) recognized.add("data de nascimento");
    } else if (kind === "address") {
      result.address = value;
      entry.used = true;
      recognized.add("endereço");
    } else if (kind === "city") {
      const cityState = extractCityState(value);
      result.city = cityState?.city || value;
      if (cityState?.state) result.state = cityState.state;
      entry.used = true;
      recognized.add("cidade/UF");
    } else if (kind === "state") {
      result.state = value.toUpperCase().slice(0, 2);
      entry.used = true;
      recognized.add("cidade/UF");
    } else if (kind === "notes") {
      addNote(notes, value);
      entry.used = true;
      recognized.add("observações");
    } else if (kind === "metadata") {
      addNote(notes, entry.label.raw + ": " + value);
      entry.used = true;
      recognized.add("observações");
    }
  }

  for (const entry of entries) {
    if (entry.used || entry.label) continue;
    const value = entry.value;
    const cpfMatch = value.match(CPF_PATTERN);
    if (!result.cpf && cpfMatch) {
      result.cpf = normalizeCpf(cpfMatch[1]);
      entry.used = true;
      recognized.add("CPF");
      continue;
    }
    if (!result.birthDate && DATE_PATTERN.test(value)) {
      result.birthDate = parseDate(value);
      entry.used = true;
      recognized.add("data de nascimento");
      continue;
    }
    const cityState = extractCityState(value);
    if (cityState && !result.city) {
      result.city = cityState.city;
      result.state = cityState.state;
      entry.used = true;
      recognized.add("cidade/UF");
      continue;
    }
  }

  const addressEntry = entries.find((entry) => !entry.used && !entry.label && ADDRESS_PREFIX.test(entry.value));
  if (addressEntry && !result.address) {
    result.address = addressEntry.value;
    addressEntry.used = true;
    recognized.add("endereço");
  }

  const nameCandidates = entries.filter((entry) => !entry.used && !entry.label && isLikelyName(entry.value));
  if (!result.fullName && nameCandidates.length) {
    result.fullName = nameCandidates[0].value;
    nameCandidates[0].used = true;
    recognized.add("nome");
  }
  if (!result.motherName) {
    const motherCandidate = entries.find((entry) => !entry.used && !entry.label && isLikelyName(entry.value));
    if (motherCandidate) {
      result.motherName = motherCandidate.value;
      motherCandidate.used = true;
      recognized.add("nome da mãe");
    }
  }

  for (const entry of entries) {
    if (!entry.used && entry.value) addNote(notes, entry.value);
  }

  result.notes = notes.join("\n");
  if (result.notes) recognized.add("observações");
  result.recognizedFields = Array.from(recognized);
  result.confidence = Math.min(100, Math.round((recognized.size / 8) * 100));
  return result;
}

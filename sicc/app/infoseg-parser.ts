export type InfosegParseResult = {
  fullName: string;
  motherName: string;
  cpf: string;
  birthDate: string;
  city: string;
  state: string;
  address: string;
  notes: string;
  confidence: number;
  recognizedFields: string[];
};

const ADDRESS_PREFIX = /^(rua|r\.?|avenida|av\.?|travessa|tv\.?|rodovia|rodo\.?|estrada|sítio|sitio|fazenda|praça|praca|alameda|loteamento|bairro)\b/i;
const DATE_PATTERN = /^(\d{2})[\/-](\d{2})[\/-](\d{4})$/;
const CITY_STATE_PATTERN = /^(.+?)\s*(?:-|\u2013|\u2014)\s*([A-Za-z]{2})$/;
const CPF_PATTERN = /(?:^|\D)(\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2})(?:$|\D)/;

function clean(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function withoutLabel(value: string) {
  return clean(value).replace(/^(?:obs(?:erva[cç][aã]o)?|observa[cç][aã]o|informa[cç][aã]o)\s*:\s*/i, "").trim();
}

function isLikelyName(value: string) {
  const words = clean(value).split(" ").filter(Boolean);
  return words.length >= 2 && words.every((word) => /^[A-Za-zÀ-ÿ'’-]+$/.test(word));
}

function normalizeCpf(value: string) {
  return value.replace(/\D/g, "").slice(0, 11);
}

function parseDate(value: string) {
  const match = value.match(DATE_PATTERN);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : "";
}

export function parseInfosegText(rawText: string): InfosegParseResult {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => clean(line))
    .filter(Boolean);

  const recognized = new Set<string>();
  const used = new Set<number>();
  const result: InfosegParseResult = {
    fullName: "",
    motherName: "",
    cpf: "",
    birthDate: "",
    city: "",
    state: "PB",
    address: "",
    notes: "",
    confidence: 0,
    recognizedFields: [],
  };

  const cpfIndex = lines.findIndex((line) => CPF_PATTERN.test(line));
  if (cpfIndex >= 0) {
    const match = lines[cpfIndex].match(CPF_PATTERN);
    result.cpf = normalizeCpf(match?.[1] ?? lines[cpfIndex]);
    used.add(cpfIndex);
    recognized.add("CPF");
  }

  const dateIndex = lines.findIndex((line) => DATE_PATTERN.test(line));
  if (dateIndex >= 0) {
    result.birthDate = parseDate(lines[dateIndex]);
    used.add(dateIndex);
    recognized.add("data de nascimento");
  }

  const locationIndex = lines.findIndex((line) => CITY_STATE_PATTERN.test(line));
  if (locationIndex >= 0) {
    const location = lines[locationIndex].match(CITY_STATE_PATTERN);
    result.city = clean(location?.[1] ?? "");
    result.state = (location?.[2] ?? "PB").toUpperCase();
    used.add(locationIndex);
    recognized.add("cidade/UF");
  }

  const addressIndex = lines.findIndex((line, index) => {
    if (used.has(index)) return false;
    return ADDRESS_PREFIX.test(line) || (/\d{1,5}(?:\s|$)/.test(line) && /[A-Za-zÀ-ÿ]/.test(line));
  });
  if (addressIndex >= 0) {
    result.address = lines[addressIndex];
    used.add(addressIndex);
    recognized.add("endereço");
  }

  if (cpfIndex >= 0) {
    const nameCandidates = lines.slice(0, cpfIndex).map((line, index) => ({ line, index })).filter(({ index }) => !used.has(index) && isLikelyName(lines[index]));
    if (nameCandidates.length > 0) {
      result.fullName = nameCandidates[0].line;
      used.add(nameCandidates[0].index);
      recognized.add("nome");
    }
    if (nameCandidates.length > 1) {
      result.motherName = nameCandidates[1].line;
      used.add(nameCandidates[1].index);
      recognized.add("nome da mãe");
    }
  }

  if (!result.fullName) {
    const firstNameIndex = lines.findIndex((line, index) => !used.has(index) && isLikelyName(line));
    if (firstNameIndex >= 0) {
      result.fullName = lines[firstNameIndex];
      used.add(firstNameIndex);
      recognized.add("nome");
    }
  }

  if (!result.motherName) {
    const motherIndex = lines.findIndex((line, index) => !used.has(index) && isLikelyName(line) && index < (dateIndex >= 0 ? dateIndex : lines.length));
    if (motherIndex >= 0 && motherIndex !== lines.indexOf(result.fullName)) {
      result.motherName = lines[motherIndex];
      used.add(motherIndex);
      recognized.add("nome da mãe");
    }
  }

  const noteLines = lines
    .map((line, index) => ({ line: withoutLabel(line), index }))
    .filter(({ line, index }) => Boolean(line) && !used.has(index))
    .map(({ line }) => line)
    .filter((line) => !CITY_STATE_PATTERN.test(line) && !DATE_PATTERN.test(line) && !CPF_PATTERN.test(line));

  if (noteLines.length > 0) {
    result.notes = noteLines.join("\n");
    recognized.add("observações");
  }

  result.recognizedFields = Array.from(recognized);
  result.confidence = Math.min(100, Math.round((recognized.size / 7) * 100));
  return result;
}

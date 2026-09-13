import { createHash } from 'node:crypto';

export const MULTI_PERSON_VERSION = 'text-blocks-v1';
const key = text => String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
const motherLabel = /^(?:M[ÃAÄ]E?|FILIA[CÇ][AÃ]O)\b/i;
const nameLabel = /^NOME(?: COMPLETO)?\s*[:\-]?\s+/i;
const narrative = /\b(?:POLICIA|MILITAR|CIVIL|NASCIMENTO|NASC|CPF|MAE|FILIACAO|VULGO|APELIDO|RUA|AVENIDA|BAIRRO|PRESO|PRISAO|FORAGIDO|RECEPTADOR|SUSPEITO|ROUBO|VEICULO|MATERIAL|APREENDIDO|FRATURA|FOTO|TATUAGEM|BRACO|COSTAS|PEITO|PERNA|PARTICIPOU|MOROU|REALIZAVA|APOIO|DENUNCIE|NATAL|CAMARAO|CIDADE)\b/;
function plausibleName(text) {
  const value = text.replace(nameLabel, '').trim();
  const words = value.split(/\s+/);
  // NASCIMENTO is a legitimate surname except when it is a label by itself.
  const checked = key(value).replace(/\bNASCIMENTO\b/g, '');
  return words.length >= 2 && words.length <= 12 && !narrative.test(checked)
    && words.every(w => /^[\p{L}][\p{L}'’-]*$/u.test(w))
    && words.filter(w => key(w).length > 2).length >= 2;
}
function overlap(a, b) {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) / Math.max(.001, Math.min(a.width, b.width));
}
function identifier(parentId, name, occurrence) {
  const hex = createHash('sha256').update(`${parentId}\0${key(name)}\0${occurrence}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function extractMultiPersonRecords(payload, classify) {
  const lines = (payload.ocrRegions ?? []).map((r, i) => ({ ...r, index: i, text: String(r.text ?? '').trim() }))
    .filter(r => r.text && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const anchors = new Map();
  const add = (line, evidence) => {
    if (!plausibleName(line.text)) return;
    const existing = anchors.get(line.index);
    anchors.set(line.index, { ...line, fullName: line.text.replace(nameLabel, '').trim(), evidence: [...(existing?.evidence ?? []), evidence] });
  };
  for (const line of lines) {
    if (nameLabel.test(line.text)) add(line, 'explicit_name_label');
    if (!motherLabel.test(line.text)) continue;
    const above = lines.filter(r => r.index !== line.index && r.y < line.y && line.y - (r.y + r.height) < .12 && overlap(r, line) > .5 && plausibleName(r.text))
      .sort((a, b) => b.y - a.y || Math.abs(a.x - line.x) - Math.abs(b.x - line.x));
    if (above[0]) add(above[0], 'name_above_mother_label');
  }
  const hints = String(payload.originalName ?? '').replace(/\.[^.]+$/, '').split(/\s+[-–—eE&]\s+|[,;]/)
    .map(s => key(s)).filter(s => plausibleName(s));
  for (const line of lines) {
    const significant = s => key(s).split(' ').filter(w => w.length > 2).slice(0, 2).join(' ');
    if (hints.some(h => key(line.text) === h || key(line.text).startsWith(`${h} `) || significant(line.text) === significant(h))) add(line, 'filename_confirmed_in_ocr');
  }
  const ordered = [...anchors.values()].sort((a, b) => a.y - b.y || a.x - b.x);
  // Without at least two textual anchors, keep the original OCR for review;
  // never invent an identity by analyzing a face or a tattoo.
  if (ordered.length < 2) return { version: MULTI_PERSON_VERSION, status: 'REVIEW', persons: [], unassignedText: payload.imageText ?? '', reason: 'Menos de dois nomes separados com evidencia textual; revisao necessaria' };
  const assigned = new Map(ordered.map(a => [a.index, []]));
  const ambiguous = [];
  for (const line of lines) {
    if (assigned.has(line.index)) { assigned.get(line.index).push(line); continue; }
    const candidates = ordered.filter(a => a.y <= line.y && overlap(a, line) > .2)
      .filter(a => !ordered.some(b => b.index !== a.index && b.y > a.y + .01 && b.y <= line.y && overlap(b, line) > .35 && overlap(a, b) > .35))
      .map(a => ({ a, score: (line.y - a.y) + Math.abs((line.x + line.width / 2) - (a.x + a.width / 2)) * 1.5 }))
      .sort((a, b) => a.score - b.score);
    const spansColumns = candidates[1] && Math.abs(candidates[0].a.y - candidates[1].a.y) < .08 && Math.abs(candidates[0].a.x - candidates[1].a.x) > .15;
    if (!candidates.length || spansColumns || (candidates[1] && candidates[1].score - candidates[0].score < .04)) { ambiguous.push(line); continue; }
    assigned.get(candidates[0].a.index).push(line);
  }
  const occurrences = new Map();
  const persons = ordered.map(anchor => {
    const block = assigned.get(anchor.index).sort((a, b) => a.y - b.y || a.x - b.x);
    const text = block.map(r => r.text).join('\n');
    const continuation = block.find(r => r.y > anchor.y && r.y - (anchor.y + anchor.height) < .05 && /^(?:da|de|do|das|dos)\s+[\p{L} ]+$/iu.test(r.text));
    const fullName = continuation ? `${anchor.fullName} ${continuation.text}` : anchor.fullName;
    const parserText = text.replace(/^Ma\s+(?=\p{Lu})/gmu, 'MAE ')
      .replace(/^(M[ÃA]E[^\n]+)\n((?:da|de|do|das|dos)\s+[\p{L} ]+)$/gmu, '$1 $2');
    const fields = classify(`${fullName}.jpg`, { text: parserText, captionText: '', quality: { readable: true } });
    const occurrence = (occurrences.get(key(anchor.fullName)) ?? 0) + 1;
    occurrences.set(key(anchor.fullName), occurrence);
    return {
      recordId: identifier(payload.recordId, anchor.fullName, occurrence),
      parentRecordId: payload.recordId,
      sharedImageId: payload.recordId,
      sourceImagePath: payload.sourceImagePath,
      sourceSha256: payload.sourceSha256,
      originalName: payload.originalName,
      imageFile: payload.imageFile ?? null,
      fullName,
      cpf: fields.cpf ?? null, birthDate: fields.birthDate ?? null,
      motherName: fields.motherName ?? null, nickname: fields.nickname ?? null,
      city: fields.city ?? null, state: fields.stateCode ?? null,
      tattooDescription: fields.tattooDescription ?? null,
      imageText: text,
      textRegionIndexes: block.map(r => r.index),
      nameEvidence: anchor.evidence,
      processingStatus: 'REVIEW',
      fieldValidationStatus: fields.state === 'READY' ? 'REQUIRED_FIELDS_VALID' : fields.state,
      eligibleForCompression: false,
      associationReviewRequired: true,
      missingRequiredFields: [!fields.cpf && 'cpf', !fields.birthDate && 'birthDate'].filter(Boolean),
      reason: 'Dados extraidos do bloco textual; conferir atribuicao antes de liberar cadastro individual',
    };
  });
  return { version: MULTI_PERSON_VERSION, status: 'EXTRACTED_FOR_REVIEW', persons, unassignedText: ambiguous.map(r => r.text).join('\n'), reason: 'Uma imagem compartilhada por varios registros; atribuicoes aguardam revisao' };
}

export function attachMultiPersonRecords(payload, classify) {
  if (payload.processingStatus !== 'MULTIPLE_PEOPLE') return payload;
  const extraction = extractMultiPersonRecords(payload, classify);
  return {
    ...payload,
    unassignedExistingFields: payload.unassignedExistingFields ?? Object.fromEntries(['fullName', 'cpf', 'birthDate', 'motherName', 'nickname', 'city', 'state', 'tattooDescription'].filter(field => payload[field] != null).map(field => [field, payload[field]])),
    ...Object.fromEntries(['fullName', 'cpf', 'birthDate', 'motherName', 'nickname', 'city', 'state', 'tattooDescription'].map(field => [field, null])),
    recordType: 'shared_image',
    sharedImageId: payload.recordId,
    persons: extraction.persons,
    multiPersonVersion: extraction.version,
    multiPersonStatus: extraction.status,
    multiPersonUnassignedText: extraction.unassignedText,
    reason: extraction.reason,
    eligibleForCompression: false,
    ocrReviewStatus: 'REVIEW_REQUIRED',
    missingRequiredFields: [],
  };
}

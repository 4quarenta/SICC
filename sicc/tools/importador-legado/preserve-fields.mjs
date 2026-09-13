export const PERSON_FIELDS = ['fullName', 'cpf', 'birthDate', 'motherName', 'nickname', 'city', 'state', 'tattooDescription'];
const present = value => value !== null && value !== undefined && String(value).trim() !== '';

// Keep useful prior work visible, without silently treating an old OCR value
// as confirmation by the current reader. All changed values remain auditable.
export function preserveExistingFields(previous, next) {
  const result = { ...previous, ...next };
  const preserved = [];
  const changes = { ...(previous.previousFieldValues ?? {}) };
  const evidence = { ...(previous.fieldEvidence ?? {}) };
  for (const field of PERSON_FIELDS) {
    if (!present(next[field]) && present(previous[field])) {
      result[field] = previous[field];
      preserved.push(field);
      evidence[field] = { source: 'previous_manifest', confirmedByCurrentOcr: false };
    } else if (present(next[field])) {
      if (present(previous[field]) && previous[field] !== next[field]) {
        changes[field] = [...new Set([...(changes[field] ?? []), previous[field]])];
      }
      evidence[field] = { source: 'current_extraction' };
    }
  }
  result.previousFieldValues = changes;
  result.fieldEvidence = evidence;
  result.preservedFields = preserved;
  if (preserved.length && result.processingStatus !== 'MULTIPLE_PEOPLE') {
    result.processingStatus = 'REVIEW';
    result.eligibleForCompression = false;
    result.ocrReviewStatus = 'REVIEW_REQUIRED';
    result.reason = 'Campos anteriores preservados, mas nao confirmados pela nova leitura';
  }
  result.missingRequiredFields = ['fullName', 'cpf', 'birthDate'].filter(field => !present(result[field]));
  return result;
}

export function reconcileManifestRecord(manifestRecord, checkpointRecord) {
  if (!manifestRecord) return checkpointRecord;
  if (manifestRecord.recordId !== checkpointRecord.recordId) throw new Error('IDs divergentes; merge de manifest bloqueado');
  if (manifestRecord.sourceSha256 && checkpointRecord.sourceSha256 && manifestRecord.sourceSha256 !== checkpointRecord.sourceSha256) throw new Error('Hash divergente; merge de manifest bloqueado');
  if (checkpointRecord.recordType === 'shared_image') return { ...manifestRecord, ...checkpointRecord };
  return preserveExistingFields(manifestRecord, checkpointRecord);
}

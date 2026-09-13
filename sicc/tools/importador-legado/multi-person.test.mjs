import assert from 'node:assert/strict';
import { attachMultiPersonRecords, extractMultiPersonRecords } from './multi-person.mjs';
import { classifyFullText } from './index.mjs';
import { preserveExistingFields, reconcileManifestRecord } from './preserve-fields.mjs';
const line = (text, x, y, width = .38) => ({ text, x, y, width, height: .025 });
const payload = {
  recordId: 'synthetic-image-id', processingStatus: 'MULTIPLE_PEOPLE',
  originalName: 'PESSOA ALFA E PESSOA BETA.jpg', sourceImagePath: 'private/original.jpg', sourceSha256: 'synthetic-hash',
  fullName: 'MIXED OLD NAME', cpf: 'MIXED', imageFile: null,
  ocrRegions: [
    line('NOME PESSOA ALFA', .02, .3), line('NOME PESSOA BETA', .54, .3),
    line('MAE RESPONSAVEL ALFA', .02, .35), line('MAE RESPONSAVEL BETA', .54, .35),
    line('CPF 529.982.247-25', .02, .4), line('CPF 111.444.777-35', .54, .4),
    line('NASC 01/02/2000', .02, .45), line('NASC 03/04/2001', .54, .45),
    line('CIDADE: CIDADE FICTICIA', .27, .6, .46),
  ],
};
payload.imageText = payload.ocrRegions.map(r => r.text).join('\n');
const before = JSON.stringify(payload);
const result = attachMultiPersonRecords(payload, classifyFullText);
assert.equal(JSON.stringify(payload), before, 'input not modified');
assert.equal(result.persons.length, 2);
assert.equal(result.fullName, null, 'no mixed fields at image level');
assert.equal(result.cpf, null);
assert.equal(result.unassignedExistingFields.fullName, 'MIXED OLD NAME');
assert.equal(result.persons[0].cpf, '52998224725');
assert.equal(result.persons[1].cpf, '11144477735');
assert.equal(result.persons[0].motherName, 'RESPONSAVEL ALFA');
assert.equal(result.persons[1].motherName, 'RESPONSAVEL BETA');
assert.equal(result.persons[0].birthDate, '2000-02-01');
assert.equal(result.persons[1].birthDate, '2001-04-03');
assert.notEqual(result.persons[0].recordId, result.persons[1].recordId);
assert.equal(result.persons[0].sharedImageId, result.persons[1].sharedImageId);
assert.equal(result.persons[0].sourceImagePath, result.persons[1].sourceImagePath);
assert.ok(result.persons.every(p => p.processingStatus === 'REVIEW' && !p.eligibleForCompression));
assert.deepEqual(result.persons.map(p => p.recordId), attachMultiPersonRecords(payload, classifyFullText).persons.map(p => p.recordId));
assert.equal(result.persons[0].city, null, 'ambiguous shared value is not copied to a person');
assert.equal(result.persons[1].city, null);
const vertical = { ...payload, ocrRegions: payload.ocrRegions.slice(0, 8).map(r => r.x > .5 ? { ...r, x: .02, y: r.y + .4 } : r) };
assert.deepEqual(extractMultiPersonRecords(vertical, classifyFullText).persons.map(p => p.cpf), ['52998224725', '11144477735']);
const uncertain = attachMultiPersonRecords({ ...payload, ocrRegions: [] }, classifyFullText);
assert.deepEqual(uncertain.persons, []);
assert.equal(uncertain.multiPersonStatus, 'REVIEW');
assert.equal(uncertain.multiPersonUnassignedText, payload.imageText);
console.log('Multiplas pessoas: isolamento, imagem compartilhada, ambiguidade e IDs estaveis aprovados.');
const old = { recordId: 'same-id', sourceSha256: 'same-hash', fullName: 'NOME ANTERIOR', cpf: '52998224725', birthDate: '2000-01-01', motherName: 'MAE FICTICIA', customMetadata: 'preserve' };
const reread = { recordId: 'same-id', sourceSha256: 'same-hash', fullName: 'NOME CORRIGIDO', cpf: null, birthDate: null, motherName: null, processingStatus: 'INSUFFICIENT_DATA', eligibleForCompression: false };
const kept = preserveExistingFields(old, reread);
assert.equal(kept.cpf, old.cpf);
assert.equal(kept.birthDate, old.birthDate);
assert.equal(kept.motherName, old.motherName);
assert.equal(kept.processingStatus, 'REVIEW');
assert.equal(kept.customMetadata, 'preserve');
assert.deepEqual(kept.previousFieldValues.fullName, ['NOME ANTERIOR']);
assert.equal(kept.fieldEvidence.cpf.confirmedByCurrentOcr, false);
assert.throws(() => reconcileManifestRecord(old, { ...reread, sourceSha256: 'wrong' }), /Hash divergente/);
assert.throws(() => reconcileManifestRecord(old, { ...reread, recordId: 'wrong' }), /IDs divergentes/);
assert.equal(reconcileManifestRecord(old, { ...reread, recordType: 'shared_image' }).cpf, null, 'do not reintroduce mixed root fields');

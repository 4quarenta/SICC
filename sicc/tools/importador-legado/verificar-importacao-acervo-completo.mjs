#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {plausibleName,validCpf,validDate} from './revisar-dados.mjs';

const work=resolve(process.argv[2]??'C:/Users/johna/Downloads/SICC-import-work-20260910/reports/1-arquivo-dados');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const norm=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim();
const sourceBytes=await readFile(join(work,'manifest-partes-v2','manifest-corrigido-completo.json'));
const source=JSON.parse(sourceBytes);
const packageDir=join(work,'platform-import-package');
const bytes=await readFile(join(packageDir,'full-archive-import-package.json'));
const data=JSON.parse(bytes);
const report=JSON.parse(await readFile(join(packageDir,'full-archive-import-report.json'),'utf8'));
assert.equal(data.version,'sicc-full-archive-import-v1');
assert.equal(data.sourceManifestSha256,sha(sourceBytes));
assert.equal(report.packageSha256,sha(bytes));
assert.equal(report.externalWrites,false);
assert.equal(data.remoteReconciled,false);
assert.equal(data.archive.length,37);
assert.equal(data.sourceRecords.length,11011);
assert.equal(data.sourceRecords.length,source.records.length);
let archiveBytes=0;
for(const part of data.archive){
  const compressed=await readFile(join(work,part.relativePath));
  assert.equal(compressed.length,part.bytes);
  assert.equal(sha(compressed),part.sha256);
  const uncompressed=gunzipSync(compressed);
  assert.equal(sha(uncompressed),part.uncompressedSha256);
  const parsed=JSON.parse(uncompressed);
  assert.equal(parsed.part,part.part);
  archiveBytes+=compressed.length;
}
assert.equal(archiveBytes,report.archiveBytes);
const ids=new Set(),mediaKeys=new Set();let imageBytes=0,imageCount=0,shared=0;
for(let i=0;i<data.sourceRecords.length;i++){
  const row=data.sourceRecords[i],original=source.records[i];
  assert.equal(row.recordId,original.recordId);
  assert.equal(row.sourceOrder,i+1);
  if(row.recordType==='shared_image')assert.equal(row.displayName,null);
  else if(row.displayName)assert(plausibleName(row.displayName));
  assert(!ids.has(row.recordId));ids.add(row.recordId);
  if(row.recordType==='shared_image'){
    shared++;assert(original.recordType==='shared_image'||original.processingStatus==='MULTIPLE_PEOPLE');
    assert.deepEqual(row.publicationFields,{});
  }
  if(row.media){
    assert(!mediaKeys.has(row.media.objectKey));mediaKeys.add(row.media.objectKey);
    const image=await readFile(join(work,row.media.relativePath));
    assert.equal(image.length,row.media.bytes);
    assert.equal(sha(image),row.media.sha256);
    imageBytes+=image.length;imageCount++;
  }
}
assert.equal(ids.size,11011);
assert.equal(imageCount,report.sourceImagesAvailable);
assert.equal(imageBytes,report.sourceImageBytes);
assert.equal(shared,report.sharedParents);
const peopleIds=new Set(),cpfs=new Set();
const candidateById=new Map();
for(const item of data.peopleCandidates){
  assert(!peopleIds.has(item.personRecordId));peopleIds.add(item.personRecordId);
  candidateById.set(item.personRecordId,item);
  assert(plausibleName(item.fullName)||validCpf(item.cpf));
  if(item.cpf){assert(validCpf(item.cpf));assert(!cpfs.has(item.cpf));cpfs.add(item.cpf);}
  if(item.birthDate)assert(validDate(item.birthDate,'2026-09-19'));
  assert.equal(item.status,'alive');assert.equal(item.custodyStatus,'free');
  assert(ids.has(item.sourceRecordId));
  if(item.associationScope==='individual_source')assert.equal(item.personRecordId,item.sourceRecordId);
  else assert.equal(item.associationScope,'shared_document_text');
}
for(const item of data.linkedDuplicates){
  assert(!peopleIds.has(item.personRecordId));peopleIds.add(item.personRecordId);
  const canonical=candidateById.get(item.canonicalPersonRecordId);
  assert(canonical);
  assert.equal(item.cpf,canonical.cpf);
  assert.equal(norm(item.fullName),norm(canonical.fullName));
  assert.notEqual(item.sourceRecordId,canonical.sourceRecordId);
}
for(const row of data.heldPeople){
  assert(row.holdReasons.length>0);
  assert(!peopleIds.has(row.item.personRecordId));peopleIds.add(row.item.personRecordId);
}
assert.equal(peopleIds.size,report.personItems);
assert.equal(data.linkedDuplicates.length,report.linkedDuplicateItems);
console.log(JSON.stringify({sourceRecords:ids.size,archiveParts:data.archive.length,validatedImageCount:imageCount,validatedImageBytes:imageBytes,peopleCandidates:data.peopleCandidates.length,linkedDuplicateItems:data.linkedDuplicates.length,heldPeople:data.heldPeople.length,packageSha256:sha(bytes),externalWrites:false}));

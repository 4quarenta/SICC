#!/usr/bin/env node
// Every source record is archived; only a defensible textual person is proposed.
// No network calls. No PII in stdout.
import {readFile,readdir,mkdir} from 'node:fs/promises';
import {join,resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {atomicWrite} from './atomic-file.mjs';
import {plausibleName,validCpf,validDate} from './revisar-dados.mjs';

const work=resolve(process.argv[2]??'C:/Users/johna/Downloads/SICC-import-work-20260910/reports/1-arquivo-dados');
const partsDir=join(work,'manifest-partes-v2');
const outDir=join(work,'platform-import-package');
const archiveDir=join(outDir,'archive-parts');
await mkdir(archiveDir,{recursive:true});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const norm=v=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim();
const wholeBytes=await readFile(join(partsDir,'manifest-corrigido-completo.json'));
const whole=JSON.parse(wholeBytes),wholeSha=sha(wholeBytes);
const index=JSON.parse(await readFile(join(work,'optimized-images-index.json'),'utf8'));
const progress=JSON.parse(await readFile(join(work,'optimized-images-progress.json'),'utf8'));
if(progress.failed||progress.done!==progress.total||!progress.finishedAt)throw new Error('Otimização incompleta');

const partFiles=(await readdir(partsDir)).filter(n=>/^manifest-corrigido-part\d{3}\.json$/.test(n));
const parts=[];for(const file of partFiles){const bytes=await readFile(join(partsDir,file));const value=JSON.parse(bytes);parts.push({file,bytes,value});}
parts.sort((a,b)=>a.value.part-b.value.part);
if(parts.length!==37||whole.records.length!==11011)throw new Error('Quantidade de partes/registros inesperada');
const partById=new Map(),archive=[];let cursor=0,archiveBytes=0;
for(let i=0;i<parts.length;i++){
  const {bytes,value}=parts[i];
  if(value.part!==i+1||value.recordStart!==cursor+1||value.recordEnd!==cursor+value.records.length)throw new Error(`Faixa inconsistente na parte ${i+1}`);
  const compressed=gzipSync(bytes,{level:6});
  if(!gunzipSync(compressed).equals(bytes))throw new Error(`Gzip inválido na parte ${i+1}`);
  if(compressed.length>5242880)throw new Error(`Parte excede 5 MiB: ${i+1}`);
  const partNo=String(i+1).padStart(3,'0'),localName=`part${partNo}.json.gz`;
  await atomicWrite(join(archiveDir,localName),compressed);
  archive.push({part:i+1,relativePath:`platform-import-package/archive-parts/${localName}`,objectKey:`manifest-v3/${localName}`,sha256:sha(compressed),bytes:compressed.length,uncompressedSha256:sha(bytes)});
  archiveBytes+=compressed.length;
  for(const record of value.records){
    if(whole.records[cursor]?.recordId!==record.recordId)throw new Error(`Ordem divergente na posição ${cursor+1}`);
    if(partById.has(record.recordId))throw new Error(`recordId duplicado: ${record.recordId}`);
    partById.set(record.recordId,i+1);cursor++;
  }
}
if(cursor!==whole.records.length)throw new Error('Concatenação divergente');

const sourceRecords=[],items=[],seenPersonIds=new Set(),allCpf=new Map();
const literalCpf=(person,cpf)=>{
  if(String(person.cpf??'').replace(/\D/g,'')===cpf)return true;
  const text=[person.imageText,...(person.ocrReadings??[]).filter(x=>typeof x==='string'),...(person.ocrRegions??[]).map(x=>x?.text).filter(Boolean)].join('\n');
  return [...text.matchAll(/(?<!\d)(?:\d{3}[.\s:]\d{3}[.\s:]\d{3}[-\s:]\d{2}|\d{11})(?!\d)/g)].some(m=>m[0].replace(/\D/g,'')===cpf);
};
for(let i=0;i<whole.records.length;i++){
  const r=whole.records[i],shared=r.recordType==='shared_image'||r.processingStatus==='MULTIPLE_PEOPLE';
  const entry=r.imageFile?index.files[basename(r.imageFile)]:null;
  if(entry&&entry.sourceSha256!==r.compressedSha256)throw new Error(`Hash de mídia divergente: ${r.recordId}`);
  const media=entry?{relativePath:entry.uploadRelativePath,objectKey:`legacy-v3/${sha(Buffer.from(r.recordId))}-${entry.uploadSha256}.webp`,sha256:entry.uploadSha256,bytes:entry.uploadBytes}:null;
  const displayName=!shared&&plausibleName(r.phase4?.publicationFields?.fullName)?r.phase4.publicationFields.fullName:null;
  sourceRecords.push({recordId:r.recordId,sourceOrder:i+1,partNumber:partById.get(r.recordId),recordType:shared?'shared_image':'individual',archiveObjectKey:`manifest-v3/part${String(partById.get(r.recordId)).padStart(3,'0')}.json.gz`,originalName:r.originalName??null,displayName,publicationFields:shared?{}:(r.phase4?.publicationFields??{}),sourcePersonCount:shared?(r.persons??[]).length:0,media});
  for(const person of shared?(r.persons??[]):[r]){
    if(seenPersonIds.has(person.recordId))throw new Error(`person recordId duplicado: ${person.recordId}`);
    seenPersonIds.add(person.recordId);
    const f=person.phase4?.publicationFields??{};
    const name=plausibleName(f.fullName)?f.fullName:null;
    const cpf=validCpf(f.cpf)&&literalCpf(person,String(f.cpf).replace(/\D/g,''))?String(f.cpf).replace(/\D/g,''):null;
    const mother=plausibleName(f.motherName)&&person.phase4?.fields?.motherName?.status==='SUPPORTED'?f.motherName:null;
    const supported=field=>person.phase4?.fields?.[field]?.status==='SUPPORTED';
    const note=String(f.notes??'').trim();
    const safeNote=note.length<=180&&!/\b(?:ACUSAD[OA]|SUSPEIT[OA]|MANDADO|PRIS[AÃ]O|PROCESSO|ARTIGO|HOMIC[IÍ]DIO|TR[AÁ]FICO|ROUBO|FURTO)\b/i.test(note)?note:null;
    const address=String(f.address??'').trim();
    const supportedAddress=(person.phase4?.addressCandidates??[]).some(a=>a?.status==='SUPPORTED'&&a.value===address);
    const item={personRecordId:person.recordId,sourceRecordId:r.recordId,associationScope:shared?'shared_document_text':'individual_source',fullName:name,cpf,motherName:mother,birthDate:supported('birthDate')&&validDate(f.birthDate,'2026-09-19')?f.birthDate:null,nickname:supported('nickname')?(f.nickname??null):null,city:supported('city')?(f.city??null):null,state:supported('state')?(f.state??null):null,address:address&&supportedAddress?address:null,notes:supported('notes')?safeNote:null,status:'alive',custodyStatus:'free',nameStatus:person.phase4?.fields?.fullName?.status??'UNKNOWN',blocking:person.phase4?.blocking??[]};
    items.push(item);
    if(cpf){const group=allCpf.get(cpf)??[];group.push(item);allCpf.set(cpf,group);}
  }
}
const byPair=new Map(),allByName=new Map(),cpfByPair=new Set();
for(const item of items){
  if(!item.fullName)continue;
  const sameName=allByName.get(norm(item.fullName))??[];sameName.push(item);allByName.set(norm(item.fullName),sameName);
  if(item.cpf){if(item.motherName)cpfByPair.add(`${norm(item.fullName)}|${norm(item.motherName)}`);continue;}
  const key=item.motherName?`${norm(item.fullName)}|${norm(item.motherName)}`:norm(item.fullName);
  if(item.motherName){const list=byPair.get(key)??[];list.push(item);byPair.set(key,list);}
}
const reconciledCpfGroups=new Map();
for(const [cpf,group] of allCpf){
  if(group.length<2||group.some(item=>!item.fullName||item.nameStatus!=='SUPPORTED'||['cpfIdentityConflict','conflictingCpf','conflictingNames'].some(reason=>item.blocking.includes(reason))))continue;
  if(new Set(group.map(item=>norm(item.fullName))).size!==1)continue;
  if(new Set(group.map(item=>norm(item.motherName)).filter(Boolean)).size>1)continue;
  if(new Set(group.map(item=>item.birthDate).filter(Boolean)).size>1)continue;
  if(new Set(group.map(item=>item.sourceRecordId)).size!==group.length)continue;
  const score=item=>[item.motherName,item.birthDate,item.address,item.city,item.state].filter(Boolean).length;
  const canonical=[...group].sort((a,b)=>score(b)-score(a))[0];
  reconciledCpfGroups.set(cpf,canonical);
}
const candidates=[],linkedDuplicates=[],held=[];const holdReasons={};let named=0;
for(const item of items){
  const reasons=[];
  if(!item.fullName&&!item.cpf)reasons.push('nameNotLegible');
  if(item.fullName&&item.nameStatus!=='SUPPORTED')reasons.push('nameEvidenceNeedsReview');
  for(const reason of ['cpfIdentityConflict','conflictingCpf','conflictingNames'])if(item.blocking.includes(reason))reasons.push(reason);
  const canonical=item.cpf?reconciledCpfGroups.get(item.cpf):null;
  if(item.cpf&&(allCpf.get(item.cpf)?.length??0)>1&&!canonical)reasons.push('duplicateCpfNeedsReconciliation');
  if(!item.cpf&&item.fullName){
    const key=item.motherName?`${norm(item.fullName)}|${norm(item.motherName)}`:norm(item.fullName);
    if((item.motherName?byPair:allByName).get(item.motherName?key:norm(item.fullName))?.length>1)reasons.push('duplicateNameNeedsReconciliation');
    if(item.motherName&&cpfByPair.has(key))reasons.push('matchesCpfIdentityWithoutCpf');
  }
  if(item.fullName)named++;
  const clean={...item};delete clean.nameStatus;delete clean.blocking;
  if(canonical&&canonical!==item){linkedDuplicates.push({...clean,canonicalPersonRecordId:canonical.personRecordId});continue;}
  if(reasons.length){held.push({item:clean,holdReasons:reasons});for(const reason of reasons)holdReasons[reason]=(holdReasons[reason]??0)+1;}
  else candidates.push(clean);
}
const packageData={version:'sicc-full-archive-import-v1',createdAt:new Date().toISOString(),sourceManifestSha256:wholeSha,originalSourceManifestSha256:whole.sourceManifestSha256??null,defaultStatusAuthorizedByUser:true,remoteReconciled:false,archive,sourceRecords,peopleCandidates:candidates,linkedDuplicates,heldPeople:held};
const packagePath=join(outDir,'full-archive-import-package.json');await atomicWrite(packagePath,JSON.stringify(packageData));
const mediaRows=sourceRecords.filter(r=>r.media);
const report={sourceRecords:sourceRecords.length,personItems:items.length,namedPersonItems:named,peopleCandidates:candidates.length,linkedDuplicateItems:linkedDuplicates.length,heldPersonItems:held.length,holdReasons,sharedParents:sourceRecords.filter(r=>r.recordType==='shared_image').length,sharedPersonItems:items.filter(i=>i.associationScope==='shared_document_text').length,sourceImagesAvailable:mediaRows.length,sourceImagesMissing:sourceRecords.length-mediaRows.length,sourceImageBytes:mediaRows.reduce((sum,r)=>sum+r.media.bytes,0),archiveParts:archive.length,archiveBytes,packageSha256:sha(await readFile(packagePath)),sourceManifestSha256:wholeSha,remoteReconciliationComplete:false,externalWrites:false};
await atomicWrite(join(outDir,'full-archive-import-report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));

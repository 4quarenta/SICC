#!/usr/bin/env node
// Idempotent SICC legacy importer. Dry-run by default; --apply writes only to
// the configured SICC Supabase project. Never prints PII or credentials.
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {atomicWrite} from './atomic-file.mjs';

const work=resolve(process.argv[2]??'C:/Users/johna/Downloads/SICC-import-work-20260910/reports/1-arquivo-dados');
const apply=process.argv.includes('--apply');
const packageDir=join(work,'platform-import-package');
const packageBytes=await readFile(join(packageDir,'full-archive-import-package.json'));
const data=JSON.parse(packageBytes);
const report=JSON.parse(await readFile(join(packageDir,'full-archive-import-report.json'),'utf8'));
const sha=buffer=>createHash('sha256').update(buffer).digest('hex');
const norm=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim();
if(data.version!=='sicc-full-archive-import-v1'||sha(packageBytes)!==report.packageSha256||data.sourceRecords.length!==11011||data.archive.length!==37||data.peopleCandidates.length!==report.peopleCandidates||data.linkedDuplicates.length!==report.linkedDuplicateItems||report.externalWrites)throw new Error('Pacote local inválido');
if(!apply){console.log(JSON.stringify({mode:'dry-run',sourceRecords:data.sourceRecords.length,archiveParts:data.archive.length,images:report.sourceImagesAvailable,peopleCandidates:data.peopleCandidates.length,linkedDuplicateItems:data.linkedDuplicates.length,heldPeople:data.heldPeople.length,bytesToUpload:report.sourceImageBytes+report.archiveBytes,packageSha256:report.packageSha256,externalWrites:false}));process.exit(0);}

const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SECRET_KEY??process.env.SUPABASE_SERVICE_ROLE_KEY;
if(!url||!key)throw new Error('Configure SUPABASE_URL e SUPABASE_SECRET_KEY no ambiente; nunca no repositório');
if(new URL(url).hostname!=='wsfvpmypmezljeltarhz.supabase.co')throw new Error('URL não corresponde ao projeto SICC verificado');
const api=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
const progressPath=join(packageDir,'import-progress.json');
const started=Date.now();const progress={version:'sicc-full-archive-import-v1',packageSha256:report.packageSha256,startedAt:new Date().toISOString(),phase:'preflight',archiveUploaded:0,imageUploaded:0,imageExisting:0,sourceRowsReady:0,peopleInserted:0,peopleExisting:0,peopleHeldRemote:0,linksReady:0,addressesReady:0,externalWrites:true};
let saveQueue=Promise.resolve();
const save=()=>{
  const snapshot=JSON.stringify({...progress,updatedAt:new Date().toISOString()},null,2);
  saveQueue=saveQueue.then(()=>atomicWrite(progressPath,snapshot));
  return saveQueue;
};
const fail=(label,error)=>{const code=error?.statusCode??error?.code??'unknown';throw new Error(`${label}: ${code}`);};
const batch=(values,size)=>Array.from({length:Math.ceil(values.length/size)},(_,i)=>values.slice(i*size,(i+1)*size));
async function allRows(table,columns,filter){
  const rows=[];for(let from=0;;from+=500){let query=api.from(table).select(columns).range(from,from+499);if(filter)query=filter(query);const {data:part,error}=await query;if(error)fail(`Leitura ${table}`,error);rows.push(...(part??[]));if((part??[]).length<500)break;}return rows;
}
async function verifiedUpload(bucket,objectKey,relativePath,expectedSha,expectedBytes,contentType){
  const bytes=await readFile(join(work,relativePath));
  if(bytes.length!==expectedBytes||sha(bytes)!==expectedSha)throw new Error(`Mídia local divergente: ${objectKey}`);
  const {error}=await api.storage.from(bucket).upload(objectKey,bytes,{contentType,upsert:false,cacheControl:'3600'});
  if(!error)return 'uploaded';
  const code=String(error.statusCode??error.status??'');
  if(code!=='409'&&!/already exists|duplicate/i.test(error.message??''))fail(`Upload ${objectKey}`,error);
  const {data:existing,error:downloadError}=await api.storage.from(bucket).download(objectKey);
  if(downloadError||!existing)fail(`Verificação de objeto existente ${objectKey}`,downloadError);
  const remote=Buffer.from(await existing.arrayBuffer());
  if(remote.length!==expectedBytes||sha(remote)!==expectedSha)throw new Error(`Objeto remoto conflitante: ${objectKey}`);
  return 'existing';
}
// Preflight before the first remote write.
const [{error:schemaError},{error:peopleSchemaError},existingSources]=await Promise.all([
  api.from('legacy_source_records').select('record_id').limit(1),
  api.from('people').select('legacy_source_record_id').limit(1),
  allRows('legacy_source_records','record_id,source_manifest_sha256'),
]);
if(schemaError||peopleSchemaError)throw new Error('A migração de importação ainda não está aplicada');
for(const row of existingSources)if(row.source_manifest_sha256!==data.sourceManifestSha256)throw new Error(`Registro remoto de outro manifesto: ${row.record_id}`);
const [{data:mediaBucket,error:mediaBucketError},{data:manifestBucket,error:manifestBucketError}]=await Promise.all([
  api.storage.getBucket('sicc-media'),api.storage.getBucket('sicc-legacy-manifests'),
]);
if(mediaBucketError||manifestBucketError||mediaBucket?.public||manifestBucket?.public)throw new Error('Buckets privados não estão configurados');
if(report.sourceImageBytes+report.archiveBytes>750_000_000)throw new Error('Lote excede o orçamento conservador de Storage Free');
await save();

progress.phase='archive';await save();
for(const part of data.archive){
  await verifiedUpload('sicc-legacy-manifests',part.objectKey,part.relativePath,part.sha256,part.bytes,'application/gzip');
  progress.archiveUploaded++;if(progress.archiveUploaded%10===0)await save();
}
await save();

progress.phase='images';await save();
const images=data.sourceRecords.filter(row=>row.media);
let next=0,completed=0;const failures=[];
async function imageWorker(){
  while(true){const i=next++;if(i>=images.length)return;const row=images[i];
    try{const result=await verifiedUpload('sicc-media',row.media.objectKey,row.media.relativePath,row.media.sha256,row.media.bytes,'image/webp');if(result==='uploaded')progress.imageUploaded++;else progress.imageExisting++;}
    catch(error){failures.push({recordId:row.recordId,reason:error.message});}
    completed++;
    if(completed%100===0){const rate=completed/((Date.now()-started)/60000);console.log(JSON.stringify({phase:'images',done:completed,total:images.length,failed:failures.length,ratePerMinute:+rate.toFixed(1),etaMinutes:+((images.length-completed)/rate).toFixed(1)}));await save();}
  }
}
await Promise.all(Array.from({length:4},imageWorker));
if(failures.length){await atomicWrite(join(packageDir,'import-errors.json'),JSON.stringify(failures,null,2));throw new Error(`${failures.length} uploads falharam; retome o mesmo pacote`);}
await save();

progress.phase='source_records';await save();
for(const rows of batch(data.sourceRecords,100)){
  const payload=rows.map(row=>({record_id:row.recordId,source_order:row.sourceOrder,part_number:row.partNumber,record_type:row.recordType,source_manifest_sha256:data.sourceManifestSha256,archive_object_key:row.archiveObjectKey,image_object_key:row.media?.objectKey??null,image_sha256:row.media?.sha256??null,image_bytes:row.media?.bytes??null,original_name:row.originalName,display_name:row.displayName,publication_fields:row.publicationFields,source_person_count:row.sourcePersonCount}));
  const {error}=await api.from('legacy_source_records').upsert(payload,{onConflict:'record_id',ignoreDuplicates:true});if(error)fail('Gravação de registros de origem',error);
  progress.sourceRowsReady+=rows.length;if(progress.sourceRowsReady%1000===0)await save();
}
const {count:sourceCount,error:sourceCountError}=await api.from('legacy_source_records').select('record_id',{count:'exact',head:true}).eq('source_manifest_sha256',data.sourceManifestSha256);
if(sourceCountError||sourceCount!==11011)throw new Error(`Conferência dos registros de origem falhou: ${sourceCount??'erro'}`);
await save();

progress.phase='people';await save();
const existingPeople=await allRows('people','id,full_name,mother_name,cpf,legacy_source_record_id,legacy_import_manifest_sha256');
const byLegacy=new Map(existingPeople.filter(r=>r.legacy_source_record_id).map(r=>[r.legacy_source_record_id,r]));
const byCpf=new Map(existingPeople.filter(r=>r.cpf).map(r=>[r.cpf,r]));
const byName=new Map();for(const person of existingPeople){if(!person.full_name)continue;const k=norm(person.full_name);const list=byName.get(k)??[];list.push(person);byName.set(k,list);}
const toInsert=[],remoteHeld=[];
for(const item of data.peopleCandidates){
  const sameLegacy=byLegacy.get(item.personRecordId);
  if(sameLegacy){
    if(sameLegacy.legacy_import_manifest_sha256!==data.sourceManifestSha256||norm(sameLegacy.full_name)!==norm(item.fullName)||String(sameLegacy.cpf??'')!==String(item.cpf??''))throw new Error(`Identidade remota divergente: ${item.personRecordId}`);
    progress.peopleExisting++;continue;
  }
  const sameCpf=item.cpf?byCpf.get(item.cpf):null;
  const sameName=Boolean(item.fullName)&&(byName.get(norm(item.fullName))??[]).some(p=>!item.cpf||(!p.mother_name&&!item.motherName)||norm(p.mother_name)===norm(item.motherName));
  if(sameCpf||sameName){remoteHeld.push({personRecordId:item.personRecordId,reason:sameCpf?'remoteCpfExists':'remoteNameOverlap'});continue;}
  toInsert.push(item);
  const planned={full_name:item.fullName,mother_name:item.motherName,cpf:item.cpf};
  if(item.cpf)byCpf.set(item.cpf,planned);
  if(item.fullName){const same=byName.get(norm(item.fullName))??[];same.push(planned);byName.set(norm(item.fullName),same);}
}
progress.peopleHeldRemote=remoteHeld.length;
await atomicWrite(join(packageDir,'remote-holds.json'),JSON.stringify({count:remoteHeld.length,records:remoteHeld},null,2));
for(const items of batch(toInsert,100)){
  const now=new Date().toISOString();
  const payload=items.map(item=>({full_name:item.fullName,nickname:item.nickname,cpf:item.cpf,birth_date:item.birthDate,mother_name:item.motherName,city:item.city,state:item.state,status:'alive',custody_status:'free',notes:item.notes,faction_id:null,created_by:null,legacy_source_record_id:item.personRecordId,legacy_parent_record_id:item.associationScope==='shared_document_text'?item.sourceRecordId:null,legacy_import_manifest_sha256:data.sourceManifestSha256,legacy_imported_at:now}));
  const {error}=await api.from('people').insert(payload);if(error)fail('Gravação de pessoas',error);
  progress.peopleInserted+=items.length;if(progress.peopleInserted%500===0)await save();
}
await save();
const importedPeople=await allRows('people','id,legacy_source_record_id,legacy_import_manifest_sha256',q=>q.eq('legacy_import_manifest_sha256',data.sourceManifestSha256));
const personByRecord=new Map(importedPeople.map(row=>[row.legacy_source_record_id,row.id]));
const ready=[...data.peopleCandidates,...data.linkedDuplicates].filter(item=>personByRecord.has(item.canonicalPersonRecordId??item.personRecordId));

progress.phase='links';await save();
const existingLinks=await allRows('legacy_source_person_links','person_id,source_record_id,person_record_id,association_scope');
const linkByRecord=new Map(existingLinks.map(row=>[row.person_record_id,row]));
const links=[];
for(const item of ready){
  const personId=personByRecord.get(item.canonicalPersonRecordId??item.personRecordId);
  const prior=linkByRecord.get(item.personRecordId);
  if(prior){if(prior.person_id!==personId||prior.source_record_id!==item.sourceRecordId||prior.association_scope!==item.associationScope)throw new Error(`Vínculo remoto divergente: ${item.personRecordId}`);progress.linksReady++;}
  else links.push({person_id:personId,source_record_id:item.sourceRecordId,person_record_id:item.personRecordId,association_scope:item.associationScope});
}
for(const rows of batch(links,100)){const {error}=await api.from('legacy_source_person_links').insert(rows);if(error)fail('Gravação de vínculos',error);progress.linksReady+=rows.length;if(progress.linksReady%500===0)await save();}
await save();

progress.phase='addresses';await save();
const existingAddresses=await allRows('addresses','legacy_source_record_id',q=>q.not('legacy_source_record_id','is',null));
const addressIds=new Set(existingAddresses.map(row=>row.legacy_source_record_id));
const addresses=ready.filter(item=>item.address&&!addressIds.has(item.personRecordId)).map(item=>({person_id:personByRecord.get(item.canonicalPersonRecordId??item.personRecordId),legacy_source_record_id:item.personRecordId,label:'Endereço histórico do acervo',address:item.address,city:item.city,state:item.state,notes:null}));
for(const rows of batch(addresses,100)){const {error}=await api.from('addresses').insert(rows);if(error)fail('Gravação de endereços',error);progress.addressesReady+=rows.length;}
const finalLinks=await allRows('legacy_source_person_links','person_id,source_record_id,person_record_id,association_scope');
const finalLinkByRecord=new Map(finalLinks.map(row=>[row.person_record_id,row]));
for(const item of ready){const link=finalLinkByRecord.get(item.personRecordId);if(!link||link.person_id!==personByRecord.get(item.canonicalPersonRecordId??item.personRecordId)||link.source_record_id!==item.sourceRecordId||link.association_scope!==item.associationScope)throw new Error(`Vínculo não confirmado: ${item.personRecordId}`);}
progress.phase='complete';progress.finishedAt=new Date().toISOString();await save();
console.log(JSON.stringify({sourceRecords:sourceCount,archiveUploaded:progress.archiveUploaded,imagesUploaded:progress.imageUploaded,imagesExisting:progress.imageExisting,peopleInserted:progress.peopleInserted,peopleExisting:progress.peopleExisting,peopleHeldRemote:progress.peopleHeldRemote,linkedDuplicateItems:data.linkedDuplicates.length,linksReady:progress.linksReady,addressesReady:progress.addressesReady,manifestSha256:data.sourceManifestSha256,externalWrites:true}));

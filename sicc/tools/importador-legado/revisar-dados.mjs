#!/usr/bin/env node
// Phase 4: text-only, auditable review. No image decoding, OCR or remote writes.
import { readFile, mkdir, stat, copyFile, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { atomicWrite } from './atomic-file.mjs';

export const VERSION = 'text-review-v1';
export const FIELDS = ['fullName', 'cpf', 'birthDate', 'motherName', 'nickname', 'city', 'state', 'address', 'tattooDescription', 'notes'];
const clean = v => String(v ?? '').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
const key = v => clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const absent = v => !clean(v) || /^(?:NAO (?:INFORMAD[OA]|CONSTA|IDENTIFICAD[OA]|INF)|IGNORAD[OA]|DESCONHECID[OA]|NULL|NULO|SEM INFORMACAO|NI|N I|S N|SEM ALCUNHA)$/.test(key(v));
const distinct = values => [...new Map(values.filter(Boolean).map(v => [key(v), v])).values()];
const nameStop = /\b(?:POLICIA|MILITAR|CIVIL|SIGILO|ABSOLUTO|PROCURAD[OA]|NACIONAL|TERRITORIO|JUSTICA|MANDADO|PRISAO|HOMICIDIO|TRAFICO|ROUBO|SUSPEITO|ABORDADO|TATUAGEM|TATUAGENS|RESTO|BALA|AMIGO|PEITO|COSTAS|BRACO|VALIDA|REGISTRO|PHOTOGRID|FILIACAO|NOME|CORPORAL|ENDERECO|RUA|BAIRRO|RESIDE|MORANDO|MORA|FAVELA|GOVERNO|ESTADO|FRENTE|VERSO|PATINHAS|CAVEIRA|CARPA|INDIA|GUEIXA|TRIBAL|NUNCA|SEMPRE|NAO INFORMADO)\b/;
export function plausibleName(v) {
  const text = clean(v).replace(/[.,;:]+$/, '').trim(); const k = key(text); const words = text.split(' ');
  if (absent(text) || text.length < 7 || text.length > 110 || words.length < 2 || words.length > 11 || nameStop.test(k)) return false;
  if (!words.every(w => /^[\p{L}][\p{L}'’-]*$/u.test(w))) return false;
  if (/\b(?:DA|DE|DO|DAS|DOS|E)$/.test(k)) return false;
  const significant = k.split(' ').filter(w => !['DA', 'DE', 'DO', 'DAS', 'DOS', 'E'].includes(w));
  return significant.length >= 2 && significant.every(w => w.length >= 2 && /[AEIOUY]/.test(w) && !/(.)\1{3}/.test(w));
}
export function validCpf(v) {
  const s = String(v ?? '').replace(/[.\s:-]/g, ''); if (!/^\d{11}$/.test(s) || /^(.)\1{10}$/.test(s)) return false;
  for (let count = 9; count <= 10; count++) { let sum = 0; for (let i = 0; i < count; i++) sum += Number(s[i]) * (count + 1 - i); const digit = (sum * 10 % 11) % 10; if (digit !== Number(s[count])) return false; } return true;
}
export function validDate(value, today = '2026-09-15') {
  let match = clean(value).match(/^(\d{4})-(\d{2})-(\d{2})$/); let y, m, d;
  if (match) [,y,m,d] = match;
  else { match = clean(value).match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/); if (!match) return null; [,d,m,y] = match; }
  const date = new Date(Date.UTC(+y, +m - 1, +d)); const iso = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  return +y >= 1900 && iso <= today && date.getUTCFullYear() === +y && date.getUTCMonth() === +m - 1 && date.getUTCDate() === +d ? iso : null;
}
const datesIn = (line, today) => {
  const numeric=[...line.matchAll(/(?<!\d)(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4})(?!\d)/g)].map(m=>validDate(m[1],today)).filter(Boolean);
  const months={JAN:1,JANEIRO:1,FEV:2,FEVEREIRO:2,MAR:3,MARCO:3,ABR:4,ABRIL:4,MAI:5,MAIO:5,JUN:6,JUNHO:6,JUL:7,JULHO:7,AGO:8,AGOSTO:8,SET:9,SETEMBRO:9,OUT:10,OUTUBRO:10,NOV:11,NOVEMBRO:11,DEZ:12,DEZEMBRO:12};
  for(const m of key(line).matchAll(/\b(\d{1,2}) (?:DE )?([A-Z]+) (?:DE )?(\d{4})\b/g)){if(months[m[2]]){const d=validDate(`${m[1]}/${months[m[2]]}/${m[3]}`,today);if(d)numeric.push(d);}}
  return numeric;
};
const primaryLabel = /^(?:NOME(?:\s+(?:COMPLETO|DA PESSOA))?)\s*[:\-]?\s+(.+)$/i;
const motherLabel = /^(?:(?:NOME\s+DA\s+)?M[AÃ]E|GENITORA)(?:\s*[:\-]\s*|\s+|$)(.*)$/i;
const birthLabel = /(?:^(?:(?:DATA|DT\.?)\s*(?:DE\s*)?)?(?:NASCIMENTO|NASCTO|NASC|NASCEU)\.?|^D\.?\s*N\.?|\bDATA\s+(?:DE\s+)?NASC(?:IMENTO)?\.?)(?=\s|[:.\-]|$)\s*[:\-]?\s*/i;
const ufPattern = '(?:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)';
const street = /^(?:RUA|R\.|AVENIDA|AV\.|TRAVESSA|TV\.|ALAMEDA|ESTRADA|RODOVIA|PRA[CÇ]A|BECO|LOTEAMENTO|CONJUNTO)\s+\S/i;
const narrative = /\b(?:SUSPEIT[OA]S?\s+DE|ABORDAD[OA]|PASSAGEM\s+POR|PRES[OA]\s+(?:POR|EM|COM)|TRAFICAVA|CONDENAD[OA]|ACUSAD[OA]|ENVOLVIMENTO\s+N[AO]|FORAGID[OA])\b/i;
const readable = v => { const s = clean(v); const letters = s.match(/\p{L}/gu) ?? []; return s.length >= 3 && letters.length / s.length > .45 && !/[�]/.test(s) && !/(.)\1{5}/.test(s); };
const fieldLine = line => /^(?:NOME|M[AÃ]E|PAI|CPF|RG|NASC|DATA|SEXO|VULGO|ALCUNHA|APELIDO|CIDADE|NATURAL|ENDERE|LOGRADOURO|OBSERVA|FILIAC|FILIAÇ|TELEFONE|INFORMA)/i.test(line);

export function reviewPerson(record, { municipalities = new Map(), today = '2026-09-15', shared = false } = {}) {
  const next = { ...record }; const fields = {}; const issues = []; const changes = [];
  const lines = String(record.imageText ?? '').split(/\r?\n/).map(clean).filter(Boolean);
  const textKey = key(lines.join(' '));
  const readings = shared ? [] : (record.ocrReadings ?? []).filter(s => typeof s === 'string');
  const rawLines = readings.flatMap(s => s.split(/\r?\n/).map(clean).filter(Boolean));
  const hint = clean(record.originalName).replace(/\.[^.]+$/, '').replace(/_/g, ' ').split(/\s+[-–—]\s+|\btatuag(?:em|ens)?\b|[,;]/i)[0];
  const significant = v => key(v).split(' ').filter(w => w.length > 2);
  const similarity = (a,b) => { const aa=significant(a),bb=significant(b); const common=aa.filter(w=>bb.includes(w)).length; return aa.length && bb.length ? common / Math.max(aa.length,bb.length) : 0; };
  const normalizeField = v => absent(v) ? null : clean(v);
  const set = (field, value, status, reason, evidence = null) => {
    const normalized = normalizeField(value); fields[field] = { status, reason, evidence }; next[field] = normalized;
    if (JSON.stringify(record[field] ?? null) !== JSON.stringify(normalized)) changes.push({field,before:record[field]??null,after:normalized,reason,evidence});
    if (status === 'AMBIGUOUS' || status === 'UNSUPPORTED' || status === 'INVALID' || status === 'INFERRED') issues.push({field,status,reason});
  };
  const choose = (field, candidates) => { const found = distinct(candidates.map(c=>c.value)); if(found.length===1)return candidates.find(c=>key(c.value)===key(found[0]));if(found.length>1)issues.push({field,status:'AMBIGUOUS',reason:'OCR contém valores concorrentes',candidates:found});return null; };
  const exactLines = (value, pool = lines) => pool.filter(line => key(line.replace(/[.,;:]+$/, '')) === key(value));
  const evidenceFor = value => exactLines(value).at(0) ?? exactLines(value,rawLines).at(0);

  // Name must be an explicitly labelled subject or agree with the stored file
  // hint. Decorative phrases, parents and document headings are not subjects.
  const labeledNames = [];
  for(let i=0;i<lines.length;i++) { const line=lines[i];const m=line.match(primaryLabel);if(m&&plausibleName(m[1]))labeledNames.push({value:m[1].replace(/[.,;:]+$/,'').trim(),evidence:line,kind:'LABEL'});if(/^NOME(?: COMPLETO| DA PESSOA)?\s*[:\-]?$/i.test(line)&&plausibleName(lines[i+1]))labeledNames.push({value:lines[i+1],evidence:line+'\n'+lines[i+1],kind:'LABEL'}); }
  const nameCandidates = lines.map(line=>line.replace(/[.,;:]+$/,'').trim()).filter(plausibleName).filter(line=>!motherLabel.test(line)).filter(line=>key(line)===key(hint)||similarity(line,hint)>=.65||key(line)===key(record.fullName));
  // Rejoin only adjacent fragments whose complete sequence already agrees
  // with a stored name. Do not join a subject and a parent's name by proximity.
  for(let i=0;i<lines.length;i++)for(let n=2;n<=4&&i+n<=lines.length;n++){const combined=lines.slice(i,i+n).join(' ');if(plausibleName(combined)&&(key(combined)===key(hint)||key(combined)===key(record.fullName)))nameCandidates.push(combined);}
  let name = choose('fullName', labeledNames);
  if(!name && !labeledNames.length) {
    const ranked = distinct(nameCandidates).map(value=>({value,evidence:value,kind:'OCR_WITH_FILENAME',score:similarity(value,hint)})).sort((a,b)=>b.score-a.score);
    if(ranked.length && (ranked[0].score>=.6 || (shared&&key(ranked[0].value)===key(record.fullName))) && (ranked.length===1||ranked[0].score>ranked[1].score))name=ranked[0];
  }
  if(name){
    const previousKey=key(record.fullName),candidateKey=key(name.value);
    const shortened=previousKey.startsWith(candidateKey+' ')&&plausibleName(record.fullName)&&!/(?:ATUAL|FORAGIDO|VULGO|TATUAGEM)\b/.test(previousKey)&&name.kind!=='LABEL';
    const changedSpelling=plausibleName(record.fullName)&&previousKey!==candidateKey&&!previousKey.startsWith(candidateKey+' ')&&!candidateKey.startsWith(previousKey+' ');
    if(shortened)set('fullName',record.fullName,'UNSUPPORTED','OCR contém só parte do nome; nome completo anterior preservado para revisão',name.evidence);
    else set('fullName',name.value,changedSpelling||/[A-ZÁÉÍÓÚÇ]{2,}[a-zà-ÿ][A-ZÁÉÍÓÚÇ]/.test(name.value)?'AMBIGUOUS':'SUPPORTED',changedSpelling?'Grafia do OCR difere do nome anterior; candidato corrigido exige conferência':'Nome da pessoa sustentado pelo texto OCR',name.evidence);
  }
  else if(plausibleName(record.fullName)) set('fullName',clean(record.fullName),'UNSUPPORTED','Nome anterior preservado, mas sem identificação textual inequívoca');
  else set('fullName',null,record.fullName?'INVALID':'MISSING','Nome ausente, incompleto ou texto incompatível com nome de pessoa');

  const cpfCandidates = [];
  for (const line of lines) {
    const labelled = line.match(/(?:^|\s)(?:N[ÚU]MERO\s+DO\s+)?CPF\s*[:.\-]?\s*(.*)$/i);
    const raw = labelled?.[1] ?? (/^[\d.\s:\-]+$/.test(line) ? line : '');
    const digits = raw.trim().replace(/[.\s:\-]/g,'');
    if(validCpf(digits))cpfCandidates.push({value:digits,evidence:line});
  }
  const cpf = choose('cpf', cpfCandidates);
  if(cpf)set('cpf',cpf.value,'SUPPORTED','CPF literal do OCR, com dígitos verificadores válidos; identidade não confirmada',cpf.evidence);
  else if(record.cpf&&validCpf(record.cpf))set('cpf',String(record.cpf).replace(/[.\s:\-]/g,''),'UNSUPPORTED','CPF válido no cálculo, mas não confirmado literalmente no OCR selecionado');
  else set('cpf',null,record.cpf?'INVALID':'MISSING','CPF ausente ou inválido; nenhum dígito foi adivinhado');

  const documentText = /\b(?:MANDADO|REGISTRO|TERRITORIO NACIONAL|TIPIFICACAO|INFORMACOES PROCESSUAIS|VALIDADE|HABILITACAO|PERMISSAO|CAT HAB|DOC IDENTIDADE|ASSINATURA|EXPEDICAO|PRONTUARIO)\b/.test(textKey);
  const nameIndex = name ? lines.findIndex(l=>key(l).includes(key(name.value))) : -1;
  const bareDates = distinct(lines.filter(l=>/^(?:\d{1,2}[/.\-]){2}\d{4}$/.test(l)).flatMap(l=>datesIn(l,today)));
  const templateNames = lines.filter(plausibleName).filter(l=>!motherLabel.test(l));
  const simpleCard = !documentText && lines.length <= 18 && nameIndex>=0 && cpfCandidates.length>0 && bareDates.length===1 && templateNames.length<=3;
  const birthCandidates=[];
  for(let i=0;i<lines.length;i++){const m=lines[i].match(birthLabel);if(m){const tail=lines[i].slice(m.index+m[0].length);for(const value of datesIn(tail,today))birthCandidates.push({value,evidence:lines[i]});if(!tail&&lines[i+1])for(const value of datesIn(lines[i+1],today))birthCandidates.push({value,evidence:lines[i]+'\n'+lines[i+1]});}}
  const birth=choose('birthDate',birthCandidates);
  if(birth)set('birthDate',birth.value,'SUPPORTED','Data de nascimento indicada por rótulo explícito',birth.evidence);
  else if(!birthCandidates.length&&simpleCard)set('birthDate',bareDates[0],'INFERRED','Data única em ficha curta de nome/CPF; confirmar que representa nascimento',lines.find(l=>datesIn(l,today).includes(bareDates[0])));
  else if(record.birthDate&&validDate(record.birthDate,today))set('birthDate',validDate(record.birthDate,today),'UNSUPPORTED','Data anterior válida no calendário, sem rótulo de nascimento inequívoco');
  else set('birthDate',null,record.birthDate?'INVALID':'MISSING','Nascimento ausente ou data inválida/futura; idade não foi convertida em data');

  const mothers=[];
  for(let i=0;i<lines.length;i++){
    const match=lines[i].match(motherLabel);let value=match?.[1];
    const filiation=lines[i].match(/^FILIA[CÇ][AÃ]O\s*[:\-]?\s*(.+?)\s*\(m[aã]e\)/i);
    if(filiation)value=filiation[1];
    if(match&&!value&&plausibleName(lines[i+1]))value=lines[i+1];
    if(value){value=value.split(/\s+(?:NOME DO PAI|PAI|CPF|NASC|DATA|VULGO)\s*[:\-]/i)[0].replace(/[.,;:]+$/,'').trim();if(plausibleName(value)&&key(value)!==key(next.fullName))mothers.push({value,evidence:lines[i]+(match&&!match[1]?'\n'+lines[i+1]: '')});}
  }
  const mother=choose('motherName',mothers);
  if(mother)set('motherName',mother.value,'SUPPORTED','Nome materno indicado explicitamente no OCR',mother.evidence);
  else if(plausibleName(record.motherName)&&key(record.motherName)!==key(next.fullName)&&evidenceFor(record.motherName))set('motherName',record.motherName,'INFERRED','Nome legível presente no OCR, mas vínculo materno sem rótulo',evidenceFor(record.motherName));
  else if(simpleCard&&plausibleName(lines[nameIndex+1])&&key(lines[nameIndex+1])!==key(next.fullName))set('motherName',lines[nameIndex+1],'INFERRED','Segundo nome na ficha; candidato a nome materno, não confirmação do vínculo',lines[nameIndex+1]);
  else if(plausibleName(record.motherName)&&key(record.motherName)!==key(next.fullName))set('motherName',record.motherName,'UNSUPPORTED','Nome materno anterior sem apoio textual claro; mantido só para revisão');
  else set('motherName',null,record.motherName?'INVALID':'MISSING','Ruído, repetição do nome da pessoa ou ausência do nome materno');

  const nickCandidates=[];
  for(let i=0;i<lines.length;i++){const m=lines[i].match(/^(?:VULGO|ALCUNHA|APELIDO)\s*[:\-]?\s*(.*)$/i);if(m){const value=m[1]||lines[i+1];if(!absent(value)&&readable(value)&&clean(value).length<=65&&!fieldLine(value))nickCandidates.push({value,evidence:lines[i]+(!m[1]?'\n'+value:'')});}}
  const nick=choose('nickname',nickCandidates);
  if(nick)set('nickname',nick.value,'SUPPORTED','Alcunha indicada explicitamente no OCR',nick.evidence);
  else if(!absent(record.nickname)&&readable(record.nickname)&&clean(record.nickname).length<=65&&!/[(){}\[\]]/.test(record.nickname))set('nickname',record.nickname,'UNSUPPORTED','Alcunha anterior sem rótulo textual; não inferida a partir do sobrenome');
  else set('nickname',null,record.nickname?'INVALID':'MISSING','Alcunha ausente, placeholder ou ilegível');

  const cityCandidates=[];
  const cityRegex=new RegExp(`^(.+?)\\s*(?:[-–—,/]|\\s)\\s*(${ufPattern})$`,'i');
  for(const line of lines){if(/^(?:NATURAL(?:IDADE| DE)|LOCAL DE NASCIMENTO)/i.test(line))continue;const label=line.match(/^(?:CIDADE|MUNIC[IÍ]PIO|LOCALIDADE)\s*[:\-]?\s*(.+)$/i);const match=(label?.[1]??line).match(cityRegex);if(match){const city=municipalities.get(`${key(match[1])}|${match[2].toUpperCase()}`);if(city)cityCandidates.push({value:city.name,state:city.uf,evidence:line});}}
  const city=distinct(cityCandidates.map(c=>`${c.value}|${c.state}`)).length>1?null:choose('city',cityCandidates);
  if(distinct(cityCandidates.map(c=>`${c.value}|${c.state}`)).length>1)issues.push({field:'city',status:'AMBIGUOUS',reason:'Mais de um município/UF no texto'});
  if(city){set('city',city.value,'SUPPORTED','Município/UF literal no OCR e existente no IBGE; residência atual não confirmada',city.evidence);set('state',city.state,'SUPPORTED','UF associada ao município no mesmo trecho OCR',city.evidence);}
  else {
    const known=municipalities.get(`${key(record.city)}|${key(record.state)}`);
    if(known){set('city',known.name,'UNSUPPORTED','Município existente, sem localidade inequívoca no OCR');set('state',known.uf,'UNSUPPORTED','UF anterior sem associação textual confirmada');}
    else {set('city',null,record.city?'INVALID':'MISSING','Localidade ausente ou município/UF sem validação');set('state',null,record.state?'UNSUPPORTED':'MISSING','UF sem município confirmado no texto');}
  }

  const addresses=[];
  for(let i=0;i<lines.length;i++) {
    const l=lines[i];const m=l.match(/^(?:ENDERE[CÇ]OS?|LOGRADOURO|RESID[EÊ]NCIA|RESIDE(?:\s+N[AO])?|MORA(?:\s+(?:N[AO]|EM))?)\s*[:\-]?\s*(.*)$/i);
    let value=m?.[1] || (m&&!m[1]?lines[i+1]:null);
    if(!m&&street.test(l)&&!documentText)value=l;
    let continuation='';
    if(value&&/\b(?:NO|NA|EM|DO|DA|RUA|AVENIDA|TRAVESSA)\s*$/i.test(value)&&lines[i+1]&&!fieldLine(lines[i+1])&&readable(lines[i+1])){continuation=lines[i+1];value+=' '+continuation;}
    if(value&&!absent(value)&&!fieldLine(value)&&readable(value)&&clean(value).length>=8)addresses.push({value:clean(value),evidence:l+(continuation?'\n'+continuation:m&&!m[1]?'\n'+value:''),status:m&&!/(?:[,;]|\bNO|\bNA|\bEM|\bDO|\bDA)\s*$/i.test(value)?'SUPPORTED':'INFERRED'});
  }
  const uniqueAddresses=distinct(addresses.map(a=>a.value));
  if(uniqueAddresses.length===1){const a=addresses.find(a=>a.value===uniqueAddresses[0]);set('address',a.value,a.status,'Endereço transcrito do OCR; pode ser parcial ou histórico',a.evidence);}
  else if(uniqueAddresses.length>1)set('address',record.address??null,'AMBIGUOUS','Mais de um endereço textual; não foi escolhido um por suposição',uniqueAddresses.join('\n'));
  else if(!absent(record.address))set('address',record.address,'UNSUPPORTED','Endereço anterior sem apoio textual');
  else set('address',null,'MISSING','Nenhum endereço textual extraído com segurança');

  let tattoo=normalizeField(record.tattooDescription);const noteParts=[];
  const filenameTattoo=shared?null:clean(record.originalName).replace(/\.[^.]+$/,'').match(/\btatuag(?:em|ens)(?=[\s:_\-]|$)\s*[:_\-]?\s*(.+)$/i)?.[1];
  if(filenameTattoo&&readable(filenameTattoo)&&!absent(filenameTattoo))tattoo=filenameTattoo.replace(/_/g,' ');
  if(tattoo){
    const allegation=tattoo.search(narrative);if(allegation>=0){noteParts.push({text:tattoo.slice(allegation),source:'previous_tattooDescription',historical:true});tattoo=tattoo.slice(0,allegation).replace(/[.;,\s]+$/,'')||null;}
    if(tattoo&&next.nickname){const parts=tattoo.split(/[,;]/).map(clean);if(parts.length>1)tattoo=parts.filter(part=>key(part)!==key(next.nickname)).join(', ')||null;}
    if(tattoo)tattoo=tattoo.replace(/\bALERQUINA\b/gi,'ARLEQUINA').replace(/\bGANG LOOSE\b/gi,'hang loose');
  }
  if(tattoo&&readable(tattoo))set('tattooDescription',tattoo,'UNSUPPORTED','Descrição textual anterior preservada; corrigida apenas forma e separação de observações. Desenhos não foram reavaliados',record.tattooDescription);
  else set('tattooDescription',null,record.tattooDescription?'INVALID':'MISSING','Descrição ausente ou ilegível');
  if(!absent(record.notes))noteParts.push({text:clean(record.notes),source:'previous_notes',historical:true});
  for(const line of lines){const m=line.match(/^OBS(?:ERVA[CÇ][OÕ][EÊ]S|ERVA[CÇ][AÃ]O)?\.?\s*[:\-]\s*(.+)$/i);if(m&&readable(m[1])&&!absent(m[1]))noteParts.push({text:m[1],source:'imageText',historical:true});else if(!documentText&&narrative.test(line)&&readable(line)&&line.length>15)noteParts.push({text:line,source:'imageText',historical:true});}
  const notes=distinct(noteParts.map(p=>p.text));
  if(notes.length)set('notes',notes.map(n=>`Registro histórico do acervo (conteúdo não verificado): ${n}`).join('\n'),'UNSUPPORTED','Observações preservadas com atribuição à fonte; não são fatos atuais confirmados',notes.join('\n'));
  else set('notes',null,'MISSING','Sem observação explícita extraída; OCR integral preservado');
  const blocking = ['fullName','cpf'].filter(f=>fields[f]?.status!=='SUPPORTED');
  if(shared)blocking.push('sharedImageAssociation');
  if(labeledNames.length>1&&distinct(labeledNames.map(c=>c.value)).length>1)blocking.push('conflictingNames');
  if(distinct(cpfCandidates.map(c=>c.value)).length>1)blocking.push('conflictingCpf');
  const publicationFields=Object.fromEntries(FIELDS.map(f=>[f,fields[f]?.status==='SUPPORTED'?next[f]:null]));
  next.fieldEvidence={...(record.fieldEvidence??{}),...Object.fromEntries(FIELDS.map(f=>[f,{source:VERSION,status:fields[f].status,evidence:fields[f].evidence}]))};
  return { next, changes, review: { version:VERSION, method:'rule_based_text_review', semanticReview:'AUTOMATED_WITH_TARGETED_SAMPLES', fields, issues, blocking, publicationFields, addressCandidates:addresses, historicalNoteSources:noteParts, status:blocking.length?'REVIEW_REQUIRED':'TEXT_PREPARED' } };
}

export async function runReview({workDir, apply=false, today=new Date().toISOString().slice(0,10)}) {
  workDir=await realpath(resolve(workDir));const out=join(workDir,'phase4');await mkdir(out,{recursive:true});
  const dbPath=join(workDir,'checkpoint.sqlite');const manifestPath=join(workDir,'manifest.json');
  const original=JSON.parse(await readFile(manifestPath,'utf8'));if(original.phase4?.version===VERSION)throw new Error('Fase 4 já aplicada; use o snapshot para uma nova revisão versionada');
  const backupDir=join(out,'before-review');await mkdir(backupDir,{recursive:true});
  for(const name of ['checkpoint.sqlite','manifest.json'])await copyFile(join(workDir,name),join(backupDir,name),1).catch(e=>{if(e.code!=='EEXIST')throw e;});
  const citiesPath=join(out,'ibge-municipalities.json');let cities;
  try{cities=JSON.parse(await readFile(citiesPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;const response=await fetch('https://servicodados.ibge.gov.br/api/v1/localidades/municipios');if(!response.ok)throw new Error('IBGE indisponível');const raw=await response.json();cities=raw.map(m=>({id:m.id,name:m.nome,uf:m.microrregiao?.mesorregiao?.UF?.sigla??m['regiao-imediata']?.['regiao-intermediaria']?.UF?.sigla})).filter(m=>m.uf);await atomicWrite(citiesPath,JSON.stringify(cities));}
  const municipalities=new Map(cities.map(m=>[`${key(m.name)}|${m.uf}`,m]));
  const audit=[];const reviewItems=[];const technical=[];const records=[];
  const db=new DatabaseSync(dbPath,{readOnly:!apply});db.exec('pragma busy_timeout=30000');
  if(db.prepare('pragma quick_check').get().quick_check!=='ok')throw new Error('Checkpoint corrompido');
  const dbRows=db.prepare('select source_path,source_sha256,payload from files where payload is not null order by source_path').all();
  if(original.records.length!==dbRows.length)throw new Error('Total do manifest difere do checkpoint');
  const dbById=new Map(dbRows.map(r=>[JSON.parse(r.payload).recordId,r]));
  const media=[];let imageBytes=0;let maxImageBytes=0;const pathSeen=new Set();
  for(const record of original.records){
    const row=dbById.get(record.recordId);if(!row||row.source_sha256!==record.sourceSha256)throw new Error('ID/hash do manifest diverge do checkpoint');
    const current=JSON.parse(row.payload);if(current.compressedSha256!==record.compressedSha256)throw new Error('Manifest de compressão desatualizado');
    let mediaOK=false;
    if(record.currentImagePath&&record.compressedSha256){try{const path=await realpath(record.currentImagePath);const rel=relative(join(workDir,'images'),path);if(isAbsolute(rel)||rel.startsWith('..'))throw new Error('Imagem fora da pasta images');const info=await stat(path);if(info.size!==record.compressedBytes||info.size>199000)throw new Error('Tamanho divergente');const bytes=await readFile(path);if(createHash('sha256').update(bytes).digest('hex')!==record.compressedSha256)throw new Error('Hash divergente');mediaOK=true;if(!pathSeen.has(path)){imageBytes+=info.size;pathSeen.add(path);}maxImageBytes=Math.max(maxImageBytes,info.size);media.push({recordId:record.recordId,imageFile:record.imageFile,currentImagePath:path,sha256:record.compressedSha256,bytes:info.size,sourceSha256:record.sourceSha256,recordType:record.recordType??'single_image'});}catch(e){technical.push({recordId:record.recordId,reason:e.message,sourceImagePath:record.sourceImagePath});}}
    else technical.push({recordId:record.recordId,reason:record.compressionError??record.sourceDeletionError??'Sem imagem comprimida',sourceImagePath:record.sourceImagePath});
    const reviewOne=(person,shared)=>{const result=reviewPerson(person,{municipalities,today,shared});if(!mediaOK)result.review.blocking.push('mediaUnavailable');result.review.status=result.review.blocking.length?'REVIEW_REQUIRED':'TEXT_PREPARED';result.next.phase4=result.review;result.next.publicationStatus=result.review.status;for(const c of result.changes)audit.push({recordId:person.recordId,parentRecordId:record.recordId,...c});reviewItems.push({recordId:person.recordId,parentRecordId:record.recordId,shared,mediaOK,before:Object.fromEntries(FIELDS.map(f=>[f,person[f]??null])),after:Object.fromEntries(FIELDS.map(f=>[f,result.next[f]??null])),imageText:person.imageText??'',...result.review});return result.next;};
    if(record.recordType==='shared_image'){const next={...record,persons:(record.persons??[]).map(p=>reviewOne(p,true)),phase4:{version:VERSION,status:'SHARED_IMAGE_REVIEW',reason:'Dados individuais revisados dentro dos blocos existentes; associações preservadas para revisão'}};records.push(next);if(!record.persons?.length)reviewItems.push({recordId:record.recordId,parentRecordId:record.recordId,shared:true,mediaOK,after:{},before:{},imageText:record.imageText??'',status:'REVIEW_REQUIRED',blocking:['noIndividualTextBlocks'],fields:{},issues:[]});}
    else records.push(reviewOne(record,false));
  }
  // Do not merge records solely because their CPF matches. Flag contradictions
  // and keep all original record IDs for review and idempotent publication.
  const cpfGroups=new Map();for(const r of reviewItems){const cpf=r.after.cpf;if(cpf&&validCpf(cpf)){if(!cpfGroups.has(cpf))cpfGroups.set(cpf,[]);cpfGroups.get(cpf).push(r);}}
  const duplicates=[];
  for(const [cpf,group] of cpfGroups){if(group.length<2)continue;const names=distinct(group.map(r=>r.after.fullName));const births=distinct(group.map(r=>r.after.birthDate));const mothers=distinct(group.map(r=>r.after.motherName));const conflict=names.length>1||births.length>1||mothers.length>1;duplicates.push({cpf,recordIds:group.map(r=>r.recordId),names,births,mothers,conflict});for(const r of group){r.blocking.push(conflict?'cpfIdentityConflict':'duplicateCpfNeedsLink');r.status='REVIEW_REQUIRED';}}
  const itemMap=new Map(reviewItems.map(i=>[i.recordId,i]));for(const r of records){for(const p of r.persons??[r]){const item=itemMap.get(p.recordId);if(p.phase4&&item){p.phase4.blocking=item.blocking;p.phase4.status=item.status;p.publicationStatus=item.status;}}}
  const mediaById=new Map(media.map(m=>[m.recordId,m]));
  const publication=reviewItems.filter(r=>r.status==='TEXT_PREPARED').map(r=>({recordId:r.recordId,sourceRecordId:r.parentRecordId,person:{full_name:r.publicationFields.fullName,cpf:r.publicationFields.cpf,birth_date:r.publicationFields.birthDate,mother_name:r.publicationFields.motherName,nickname:r.publicationFields.nickname,city:r.publicationFields.city,state:r.publicationFields.state},addresses:r.publicationFields.address?[{label:'Endereço histórico do acervo',address:r.publicationFields.address}]:[],media:mediaById.get(r.parentRecordId),omittedFields:FIELDS.filter(f=>r.after[f]&&r.fields[f]?.status!=='SUPPORTED'),publicationStatus:'PREPARED_NOT_PUBLISHED'}));
  const bytesOf=o=>Buffer.byteLength(JSON.stringify(o),'utf8');const leanRecords=reviewItems.map(r=>({recordId:r.recordId,parentRecordId:r.parentRecordId,fields:r.after,status:r.status,blocking:r.blocking,imageText:r.imageText}));
  const counts={};const changedFields={};const issueCounts={};for(const r of reviewItems){counts[r.status]=(counts[r.status]??0)+1;for(const issue of r.issues)issueCounts[`${issue.field}:${issue.status}`]=(issueCounts[`${issue.field}:${issue.status}`]??0)+1;}for(const c of audit)changedFields[c.field]=(changedFields[c.field]??0)+1;
  const contentHashes=new Map();for(const m of media)if(!contentHashes.has(m.sha256))contentHashes.set(m.sha256,m.bytes);const dedupBytes=[...contentHashes.values()].reduce((a,b)=>a+b,0);
  const readyMedia=[...new Map(publication.map(r=>[r.media.sha256,r.media])).values()];const readyImageBytes=readyMedia.reduce((a,b)=>a+b.bytes,0);
  const textualBytes=bytesOf(leanRecords);const preparedBytes=bytesOf(publication);const estimatedRows=reviewItems.length+media.length+reviewItems.filter(r=>r.after.address).length+reviewItems.length;
  const preparedRows=publication.length*2+readyMedia.length+publication.reduce((n,r)=>n+r.addresses.length,0);
  const summary={version:VERSION,generatedAt:new Date().toISOString(),applied:apply,totalImageRecords:records.length,individualRecords:reviewItems.filter(r=>!r.blocking.includes('noIndividualTextBlocks')).length,sharedImages:records.filter(r=>r.recordType==='shared_image').length,sharedImagesWithoutPeople:reviewItems.filter(r=>r.blocking.includes('noIndividualTextBlocks')).length,reviewItems:reviewItems.length,changes:audit.length,recordsChanged:new Set(audit.map(a=>a.recordId)).size,changedFields,counts,issueCounts,duplicateCpfGroups:duplicates.length,conflictingCpfGroups:duplicates.filter(d=>d.conflict).length,technicalErrors:technical.length,media:{verified:media.length,totalBytes:imageBytes,maxBytes:maxImageBytes,uniqueObjects:contentHashes.size,deduplicatedBytes:dedupBytes,duplicateSavings:imageBytes-dedupBytes,preparedSubsetObjects:readyMedia.length,preparedSubsetBytes:readyImageBytes},storage:{freeQuotaBytesConservative:1e9,allImagesPercent:imageBytes/1e7,remainingIfEmpty:1e9-imageBytes,remainingWithDedupIfEmpty:1e9-dedupBytes,liveUsageVerified:false,formula:'uso_atual_organizacao + novos_arquivos - arquivos_ja_existentes'},database:{freeQuotaBytes:500e6,originalManifestBytes:(await stat(manifestPath)).size,leanTextAndOcrBytes:textualBytes,preparedPackageBytes:preparedBytes,estimatedRows,estimatedGrowthLow:Math.ceil(textualBytes*1.5+estimatedRows*1024),estimatedGrowthHigh:Math.ceil(textualBytes*3+estimatedRows*4096),method:'Estimativa de planejamento: 1,5–3 vezes texto UTF-8 mais 1–4 KiB por linha de pessoa/mídia/endereço/auditoria. Não é medição de PostgreSQL.'},scope:{imagesAnalyzed:false,rawOcrPreserved:true,externalWrites:false,manualSemanticReviewOfEveryRecord:false}};
  summary.database.preparedSubset={records:publication.length,estimatedRows:preparedRows,estimatedGrowthLow:Math.ceil(preparedBytes*1.5+preparedRows*1024),estimatedGrowthHigh:Math.ceil(preparedBytes*3+preparedRows*4096)};
  summary.fieldStatuses=Object.fromEntries(FIELDS.map(field=>[field,reviewItems.reduce((counts,r)=>{const status=r.fields[field]?.status;if(status)counts[status]=(counts[status]??0)+1;return counts;},{})]));
  await atomicWrite(join(out,'corrections.jsonl'),audit.map(x=>JSON.stringify(x)).join('\n')+'\n');
  await atomicWrite(join(out,'review-items.json'),JSON.stringify(reviewItems));
  await atomicWrite(join(out,'technical-exclusions.json'),JSON.stringify(technical,null,2));
  await atomicWrite(join(out,'duplicate-cpf-groups.json'),JSON.stringify(duplicates,null,2));
  await atomicWrite(join(out,'publication-prepared.json'),JSON.stringify({version:1,published:false,records:publication},null,2));
  await atomicWrite(join(out,'media-inventory.json'),JSON.stringify(media));
  await atomicWrite(join(out,'summary.json'),JSON.stringify(summary,null,2));
  const reviewed={...original,generatedAt:summary.generatedAt,phase4:{version:VERSION,method:'rule_based_text_review',status:'REVIEW_AND_PUBLICATION_PREPARATION',summaryPath:'phase4/summary.json'},records};
  await atomicWrite(join(out,'manifest-reviewed.json'),JSON.stringify(reviewed,null,2));
  if(apply){db.exec('begin immediate');try{db.exec('create table if not exists phase4_history(record_id text primary key,prior_payload text not null,review_version text not null,saved_at text not null)');const history=db.prepare('insert or ignore into phase4_history values(?,?,?,?)');const update=db.prepare('update files set payload=?,updated_at=? where source_path=?');for(const r of records){const row=dbById.get(r.recordId);history.run(r.recordId,row.payload,VERSION,summary.generatedAt);update.run(JSON.stringify(r),summary.generatedAt,row.source_path);}db.exec('commit');}catch(e){db.exec('rollback');throw e;}await atomicWrite(manifestPath,JSON.stringify(reviewed,null,2));}
  db.close();console.log(JSON.stringify(summary,null,2));return summary;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const args=process.argv.slice(2);const i=args.indexOf('--work');if(i<0)throw new Error('Informe --work');runReview({workDir:args[i+1],apply:args.includes('--apply')}).catch(e=>{console.error(e.message);process.exitCode=1;});}

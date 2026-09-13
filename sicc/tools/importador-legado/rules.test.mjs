import assert from "node:assert/strict";
import { chooseValidCpf, classifyRecord, detectMultiplePeople, isValidCpf, normalizeCpf, parseBrazilianDate, parseFilename, parseOcrFields } from "./index.mjs";

assert.equal(normalizeCpf("096.697.734-31"), "09669773431");
assert.equal(isValidCpf("09669773431"), true);
assert.equal(isValidCpf("09669773430"), false);
assert.equal(parseBrazilianDate("19/12/1984"), "1984-12-19");
assert.equal(parseBrazilianDate("31/02/1984"), null);

const filename = parseFilename("PESSOA TESTE - VULGO TIGRE tatuagem_ braço esquerdo (caveira).jpg");
assert.equal(filename.fullName, "PESSOA TESTE");
assert.equal(filename.nickname, "TIGRE");
assert.match(filename.tattooDescription, /braço esquerdo/i);
const inlineVulgo = parseFilename("FABIANO VERISSIMO DOS SANTOS VULGO BIANO.jpg");
assert.equal(inlineVulgo.fullName, "FABIANO VERISSIMO DOS SANTOS");
assert.equal(inlineVulgo.nickname, "BIANO");
const dashedNickname = parseFilename("ABIMAEL LOURENCO FRANCA - BAIANO.jpg");
assert.equal(dashedNickname.fullName, "ABIMAEL LOURENCO FRANCA");
assert.equal(dashedNickname.nickname, "BAIANO");
const commaTattoos = parseFilename("PESSOA TESTE, CARPA, COROA NO BRACO.jpg");
assert.equal(commaTattoos.fullName, "PESSOA TESTE");
assert.equal(commaTattoos.nickname, null);
assert.equal(commaTattoos.tattooDescription, "CARPA, COROA NO BRACO");
const inlineTattoo = parseFilename("PESSOA TESTE_TATUAGEM BRACO ESQUERDO.jpg");
assert.equal(inlineTattoo.fullName, "PESSOA TESTE");
assert.match(inlineTattoo.tattooDescription, /BRACO ESQUERDO/i);
const inlineNicknameAndTattoo = parseFilename("PESSOA TESTE VULGO TIGRE TATUAGEM NO PEITO.jpg");
assert.equal(inlineNicknameAndTattoo.fullName, "PESSOA TESTE");
assert.equal(inlineNicknameAndTattoo.nickname, "TIGRE");
assert.match(inlineNicknameAndTattoo.tattooDescription, /PEITO/i);

const labeled = parseOcrFields("VULGO: BIANO\nMÃE: FRANCISCA LEANDRO VERISSIMO\nCPF: 12196870498\nDN: 25/01/1992\nSAO GONCALO DO AMARANTE - RN");
assert.equal(labeled.nickname, "BIANO");
assert.equal(labeled.motherName, "FRANCISCA LEANDRO VERISSIMO");
assert.equal(labeled.city, "SAO GONCALO DO AMARANTE");
assert.equal(labeled.state, "RN");

const caption = parseOcrFields("PESSOA TESTE\nMAE FULANA DE TESTE\nNASC 19/12/1984\nCIDADE: JOAO PESSOA - PB");
assert.equal(caption.fullName, "PESSOA TESTE");
assert.equal(caption.motherName, "FULANA DE TESTE");
assert.equal(caption.birthDate, "1984-12-19");
assert.equal(caption.city, "JOAO PESSOA");
assert.equal(caption.state, "PB");
const dateMustNotBeMother = parseOcrFields("PESSOA TESTE\n23/10/1998\nNATAL - RN");
assert.notEqual(dateMustNotBeMother.motherName, "23/10/1998");
assert.equal(chooseValidCpf(["CPF 096.697.734-3I"]), "09669773431");
assert.equal(chooseValidCpf(["CPF 096.697.734-31 NASC 19/12/1984"]), "09669773431");
assert.equal(parseOcrFields("NOME: PESSOA TESTE").state, null);

assert.equal(detectMultiplePeople({ filename: "PESSOA UM e PESSOA DOIS.jpg" }), true);
assert.equal(detectMultiplePeople({ filename: "PESSOA TESTE - CARPA.jpg" }), false);

const valid = classifyRecord({ filename: "PESSOA TESTE.jpg", ocrTexts: ["CPF: 096.697.734-31\nNome: PESSOA TESTE\nNASC: 19/12/1984"], parsedFilename: { fullName: "PESSOA TESTE", nickname: null, tattooDescription: null } });
assert.equal(valid.state, "READY");
assert.equal(valid.cpf, "09669773431");

const invalid = classifyRecord({ filename: "PESSOA TESTE.jpg", ocrTexts: ["CPF: 096.697.734-30\nNome: PESSOA TESTE\nNASC: 19/12/1984"], parsedFilename: { fullName: "PESSOA TESTE", nickname: null, tattooDescription: null } });
assert.equal(invalid.state, "INVALID_CPF");
assert.equal(invalid.fullName, "PESSOA TESTE");
assert.equal(invalid.birthDate, "1984-12-19");

const missingBirth = classifyRecord({ filename: "PESSOA TESTE.jpg", ocrTexts: ["CPF: 096.697.734-31\nNome: PESSOA TESTE"], parsedFilename: { fullName: "PESSOA TESTE", nickname: null, tattooDescription: null } });
assert.equal(missingBirth.state, "REVIEW");

console.log("Regras determinísticas do importador: aprovadas.");

import { parseInfosegText } from "../app/infoseg-parser.ts";

const labeledRecord = `Nome:
DIEGO EUZEBIO DA SILVA
Filiação 1:
DAMIANA EUZEBIO DA SILVA
Sexo:
Masculino
Data Nascimento:
19/12/1984
CPF:
096.697.734-31
Abordado na av da alegria
Passagem por furto qualificado`;

const expected = {
  fullName: "DIEGO EUZEBIO DA SILVA",
  motherName: "DAMIANA EUZEBIO DA SILVA",
  cpf: "09669773431",
  birthDate: "1984-12-19",
  approach: "na av da alegria",
};

const variants = [
  labeledRecord,
  labeledRecord.replace(/\n/g, "\r"),
  labeledRecord.replace(/\n/g, "\u2028").replace("Nome:", "Nome：\u200e"),
  labeledRecord.replace("Nome:", "Nome").replace("Filiação 1:", "Filiação 1"),
];

for (const source of variants) {
  const parsed = parseInfosegText(source);
  if (
    parsed.fullName !== expected.fullName ||
    parsed.motherName !== expected.motherName ||
    parsed.cpf !== expected.cpf ||
    parsed.birthDate !== expected.birthDate ||
    parsed.approaches[0]?.locationLabel !== expected.approach
  ) {
    console.error(JSON.stringify(parsed, null, 2));
    throw new Error("Falha ao interpretar o formato rotulado do Infoseg.");
  }
}

console.log("Parser do Infoseg: cenários rotulados aprovados.");

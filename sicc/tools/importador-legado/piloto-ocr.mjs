import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPaddleOcrWorker, readFullText, classifyFullText, isValidCpf } from './index.mjs';
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
if (!['--work', '--samples', '--python', '--tesseract'].every(flag => args.includes(flag))) throw new Error('Informe --work --samples --python --tesseract');
const work = value('--work');
const samples = JSON.parse(await readFile(value('--samples'), 'utf8'));
const worker = createPaddleOcrWorker(value('--python'), true);
const output = [];
const tempDir = join(work, 'ocr-tmp');
await mkdir(tempDir, { recursive: true });
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
try {
  for (const sample of samples) {
    const started = Date.now();
    const source = sample.sourceImagePath ?? sample.path;
    const full = await readFullText(await readFile(source), { paddleWorker: worker, tesseractPath: value('--tesseract'), tempDir });
    const fields = classifyFullText(basename(source), full);
    if (fields.state === 'READY' && (!fields.fullName || !isValidCpf(fields.cpf) || !fields.birthDate)) throw new Error('Falha no criterio de elegibilidade');
    output.push({ recordId: sample.recordId, sourceImagePath: source, ...full, fields, seconds: (Date.now() - started) / 1000 });
    await writeFile(join(work, 'piloto-ocr-validado.json'), JSON.stringify(output, null, 2));
    console.log(JSON.stringify({ processed: output.length, total: samples.length, state: fields.state, seconds: output.at(-1).seconds }));
  }
} finally { await worker.close(); }
const html = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file:; style-src 'unsafe-inline'"><title>Piloto OCR SICC</title><style>body{font:16px system-ui;background:#eef2f5;margin:24px}article{background:white;border-radius:12px;padding:20px;margin:20px 0}section{display:grid;grid-template-columns:1fr 1fr;gap:24px}img{width:100%;max-height:850px;object-fit:contain}pre{white-space:pre-wrap;overflow-wrap:anywhere}small{color:#555}</style><h1>Piloto OCR — ${output.length} imagens</h1><p>Relatório privado local. Compare o original, a leitura e os campos. Triagem automática não garante transcrição integral.</p>${output.map((r, i) => `<article><h2>Amostra ${i + 1} — ${escape(r.fields.state)}</h2><small>${escape(r.recordId)}</small><section><img src="${escape(pathToFileURL(r.sourceImagePath).href)}"><div><h3>Texto selecionado</h3><pre>${escape(r.text)}</pre><h3>Campos</h3><pre>${escape(JSON.stringify(r.fields, null, 2))}</pre><details><summary>Leituras alternativas</summary><pre>${escape(r.readings.join('\n---\n'))}</pre></details></div></section></article>`).join('')}</html>`;
await writeFile(join(work, 'comparacao-ocr.html'), html);
const summary = { samples: output.length, readable: output.filter(r => r.quality.readable).length, states: output.reduce((a, r) => { a[r.fields.state] = (a[r.fields.state] ?? 0) + 1; return a; }, {}), averageSeconds: output.reduce((a, r) => a + r.seconds, 0) / output.length };
await writeFile(join(work, 'resumo-piloto-ocr.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));

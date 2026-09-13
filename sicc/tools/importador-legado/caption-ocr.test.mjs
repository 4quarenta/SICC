import assert from 'node:assert/strict';
import { captionBuffers, selectReading, textQuality, combineDetectedLines, OCR_VERSION } from './caption-ocr.mjs';
import { fullTextCheckpointComplete, classifyFullText } from './index.mjs';

const clean = 'PESSOA FICTICIA  TESTE\r\nMAE: EXEMPLO FICTICIO\r\n529.982.247-25\r\nNASC 01/01/2000\r\n';
const noise = 'a\r\n=\r\no\r\n%\r\nrd\r\ne\r\n!';
assert.equal(selectReading([noise, clean]), clean, 'preserve raw whitespace of best reading');
assert.equal(textQuality(noise).readable, false);
assert.equal(textQuality(clean).readable, true);
assert.equal(fullTextCheckpointComplete({ ocrVersion: 'old', ocrCompletedAt: 'now' }), false);
assert.equal(fullTextCheckpointComplete({ ocrVersion: OCR_VERSION, ocrCompletedAt: 'now' }), true);
assert.equal(fullTextCheckpointComplete({ ocrVersion: OCR_VERSION, ocrCompletedAt: 'now', ocrReviewStatus: 'ERROR' }), false);
assert.equal(fullTextCheckpointComplete({ ocrVersion: OCR_VERSION, ocrCompletedAt: 'now' }, true), false);
const synthetic = Buffer.from('<svg width="600" height="400"><rect width="600" height="400" fill="#444"/><text x="15" y="60" font-size="30" font-weight="bold" fill="yellow">TEXTO FICTICIO SUPERIOR</text><text x="15" y="350" font-size="30" font-weight="bold" fill="yellow">TEXTO FICTICIO INFERIOR</text></svg>');
const before = Buffer.from(synthetic);
const regions = await captionBuffers(synthetic);
assert.equal(regions.length, 2, 'detect text at top and bottom instead of a fixed crop');
assert.deepEqual(synthetic, before, 'source bytes remain untouched');
const neural = { width: 100, height: 100, lines: [
  { text: 'Texto branco preservado', confidence: .9, box: [0, 0, 90, 10] },
  { text: 'PESSOA FICTICIA TESTE', confidence: .9, box: [0, 80, 90, 90] },
] };
const merged = combineDetectedLines(neural, { regions: [{ text: 'PESSOA  FICTICIA TESTE\r\n', x: 0, y: .8, width: .9, height: .1 }] });
assert.equal(merged.text, 'Texto branco preservado\nPESSOA  FICTICIA TESTE\r\n');
console.log('OCR: selecao, espacamento, regioes, preservacao e retomada aprovados.');
const context = 'PESSOA FICTICIA TESTE\nEMISSAO 10/10/2022\nPESSOA FICTICIA TESTE\nMAE FICTICIA EXEMPLO\n52998224725\n01/01/2000\n';
const classified = classifyFullText('PESSOA FICTICIA TESTE.jpg', { text: context, captionText: '', quality: { readable: true } });
assert.equal(classified.birthDate, '2000-01-01', 'document issue date is not birth');
assert.equal(classified.motherName, 'FICTICIA EXEMPLO');
const narrative = classifyFullText('PESSOA FICTICIA.jpg', { text: 'PESSOA FICTICIA\nApreendido objetos produto de furto\nPreso 10/10/2022', captionText: '', quality: { readable: true } });
assert.equal(narrative.motherName, null);
assert.equal(narrative.birthDate, null);
const conflicting = classifyFullText('PESSOA FICTICIA TESTE.jpg', { text: clean + 'NASC 02/01/2000\n', captionText: clean, quality: { readable: true } });
assert.equal(conflicting.state, 'REVIEW');
assert.equal(conflicting.birthDate, null);
const nickname = classifyFullText('PESSOA FICTICIA TESTE - VULGO OUTRO.jpg', { text: clean + 'VULGO EXEMPLO\n', captionText: clean, quality: { readable: true } });
assert.equal(nickname.nickname, 'EXEMPLO');
assert.equal(nickname.stateCode, null);

import sharp from 'sharp';

export const OCR_VERSION = 'caption-v2';

// Find yellow caption glyphs throughout the original, regardless of placement.
// The mask exists only in memory for OCR; it never replaces the source image.
export async function captionBuffers(input) {
  const { data, info } = await sharp(input).rotate().resize({ width: 2400, height: 3200, fit: 'inside', withoutEnlargement: true }).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    const r = data[i * channels], g = data[i * channels + 1], b = data[i * channels + 2];
    mask[i] = r > 110 && g > 95 && b < Math.min(r, g) * .65 && r / g > .7 && r / g < 1.65 ? 1 : 0;
  }
  const queue = new Int32Array(mask.length);
  const components = [];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 1) continue;
    let read = 0, size = 1, minX = i % width, maxX = minX, minY = Math.floor(i / width), maxY = minY;
    queue[0] = i; mask[i] = 2;
    while (read < size) {
      const p = queue[read++], x = p % width, y = Math.floor(p / width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (const n of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1]) {
        if (n >= 0 && mask[n] === 1) { mask[n] = 2; queue[size++] = n; }
      }
    }
    const w = maxX - minX + 1, h = maxY - minY + 1;
    if (size >= 10 && h >= 6 && h < height * .3 && w / h < 10 && w / h > .07 && size / (w * h) > .1) {
      components.push({ minX, maxX, minY, maxY, h, size });
    }
  }
  const groups = [];
  for (const c of components.sort((a, b) => a.minY - b.minY)) {
    let group = groups.find(g => Math.min(g.maxY, c.maxY) - Math.max(g.minY, c.minY) >= Math.min(g.maxY - g.minY, c.h) * .45);
    if (!group) { group = { minX: c.minX, maxX: c.maxX, minY: c.minY, maxY: c.maxY, parts: [] }; groups.push(group); }
    group.minX = Math.min(group.minX, c.minX); group.maxX = Math.max(group.maxX, c.maxX);
    group.minY = Math.min(group.minY, c.minY); group.maxY = Math.max(group.maxY, c.maxY); group.parts.push(c);
  }
  const lines = groups.filter(g => g.parts.length >= 5 && g.maxX - g.minX > 80 && (g.maxX - g.minX) / (g.maxY - g.minY + 1) > 3).sort((a, b) => a.minY - b.minY);
  const buffers = [];
  for (const line of lines) {
    const w = line.maxX - line.minX + 1, h = line.maxY - line.minY + 1;
    const pixels = Buffer.alloc(w * h, 255);
    for (const c of line.parts) {
      for (let y = c.minY; y <= c.maxY; y++) for (let x = c.minX; x <= c.maxX; x++) {
        if (mask[y * width + x]) pixels[(y - line.minY) * w + x - line.minX] = 0;
      }
    }
    const scale = Math.max(1, Math.min(3, 42 / h));
    const buffer = await sharp(pixels, { raw: { width: w, height: h, channels: 1 } }).resize({ width: Math.round(w * scale) }).extend({ top: 15, bottom: 15, left: 15, right: 15, background: 'white' }).png().toBuffer();
    buffers.push({ buffer, box: { x: line.minX / width, y: line.minY / height, width: w / width, height: h / height }, method: 'yellow-caption-line' });
  }
  return buffers;
}

export function textQuality(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter(s => s.trim());
  const tokens = String(text ?? '').match(/\S+/g) ?? [];
  const words = tokens.filter(t => /^[\p{L}]{2,}[,.:;]?$/u.test(t));
  const dates = /\b\d{2}[/.]\d{2}[/.]\d{4}\b/.test(text);
  const number = /\d{3}[. ]?\d{3}[. ]?\d{3}[- ]?\d{2}/.test(text);
  const labels = /\b(?:M[ÃA]E|NASC|CPF|VULGO|CIDADE)\b/i.test(text);
  const shortLines = lines.filter(l => l.trim().length < 4).length;
  const ratio = tokens.length ? words.length / tokens.length : 0;
  const score = Math.min(words.length, 40) + ratio * 25 + Number(dates) * 15 + Number(number) * 15 + Number(labels) * 10 - shortLines * 3;
  return { score, readable: words.length >= 3 && ratio >= .45 && shortLines <= Math.max(2, lines.length * .2), lines: lines.length };
}

export function selectReading(readings) {
  // Return the original string, including original whitespace and newlines.
  return [...readings].sort((a, b) => textQuality(b).score - textQuality(a).score)[0] ?? '';
}

export async function readCaptions(input, recognize, validCpf) {
  const regions = await captionBuffers(input);
  const readings = [[], []];
  const chosen = [];
  for (const region of regions) {
    const candidates = [await recognize(region.buffer, '7'), await recognize(region.buffer, '13')];
    readings[0].push(candidates[0]); readings[1].push(candidates[1]);
    const score = text => {
      const digits = text.replace(/\D/g, '');
      return textQuality(text).score + (digits.length === 11 && validCpf(digits) ? 100 : 0);
    };
    chosen.push([...candidates].sort((a, b) => score(b) - score(a))[0]);
  }
  // Each region is a visual text line. Keep each OCR string untouched, adding
  // a separator only if the engine omitted the final newline.
  const joinLines = values => values.map(t => t.endsWith('\n') ? t : `${t}\n`).join('');
  return { text: joinLines(chosen), readings: readings.map(joinLines), regions: regions.map((r, i) => ({ ...r.box, text: chosen[i] })) };
}

export function combineDetectedLines(neural, captions) {
  // Low-confidence detections remain in the alternate raw reading, but should
  // not contaminate imageText with background hallucinations.
  const result = (neural.lines ?? []).filter(l => l.box?.length === 4 && l.confidence >= .6).map(l => ({
    text: l.text, confidence: l.confidence,
    x: l.box[0] / neural.width, y: l.box[1] / neural.height,
    width: (l.box[2] - l.box[0]) / neural.width,
    height: (l.box[3] - l.box[1]) / neural.height,
    method: 'paddle-mobile',
  }));
  for (const region of captions.regions) {
    const tokens = region.text.match(/\S+/g) ?? [];
    const printed = region.text.trim();
    const cleanCapitalLine = /^[\p{Lu}\p{M} .,'’:-]+$/u.test(printed) && tokens.length >= 3;
    const cleanNumericLine = /^(?:NASC\s*)?[\d\s.,/:-]+$/i.test(printed) && /\d{3}/.test(printed);
    if (!cleanCapitalLine && !cleanNumericLine) continue;
    const overlapping = result.filter(l => {
      const vertical = Math.min(l.y + l.height, region.y + region.height) - Math.max(l.y, region.y);
      const horizontal = Math.min(l.x + l.width, region.x + region.width) - Math.max(l.x, region.x);
      return vertical > Math.min(l.height, region.height) * .5 && horizontal > Math.min(l.width, region.width) * .5;
    });
    // Do not replace several separate text boxes by a single speculative line.
    if (overlapping.length > 1) continue;
    const old = overlapping[0];
    if (old && textQuality(old.text).score > textQuality(region.text).score + 10) continue;
    if (old) result.splice(result.indexOf(old), 1);
    result.push({ ...region, method: 'yellow-caption-tesseract' });
  }
  result.sort((a, b) => a.y - b.y || a.x - b.x);
  return { text: result.map(l => l.text.endsWith('\n') ? l.text : `${l.text}\n`).join(''), regions: result };
}

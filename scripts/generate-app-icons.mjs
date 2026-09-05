import { Buffer } from 'node:buffer';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
  throw new Error('Usage: node scripts/generate-app-icons.mjs [--check]');
}
const check = args[0] === '--check';
const size = 1024;
const mark = await readFile(resolve(root, 'assets/brand/mark.svg'));
const background = await sharp(resolve(root, 'assets/brand/background.svg'))
  .resize(size, size).removeAlpha().png().toBuffer();

async function markLayer(width, offsetY = 0) {
  const glyph = await sharp(mark, { density: 288 }).resize(width, width).png().toBuffer();
  const inset = (size - width) / 2;
  return sharp({ create: { width: size, height: size, channels: 4, background: '#00000000' } })
    .composite([{ input: glyph, left: inset, top: inset + offsetY }]).png().toBuffer();
}

async function flatLayer(image, [r, g, b], opacity = 1) {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error('Expected an RGBA mark layer.');
  for (let pixel = 0; pixel < data.length; pixel += 4) {
    data[pixel] = r;
    data[pixel + 1] = g;
    data[pixel + 2] = b;
    data[pixel + 3] = Math.round(data[pixel + 3] * opacity);
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

async function shadow(width) {
  const mask = await flatLayer(await markLayer(width, 14), [5, 8, 44], 0.28);
  return sharp(mask).blur(12).png().toBuffer();
}

// Adaptive layers use the full 108dp canvas; the essential mark fits its 66dp safe circle.
const adaptiveMark = await markLayer(680);
const monochrome = await flatLayer(adaptiveMark, [255, 255, 255]);
const alpha = await sharp(monochrome).extractChannel('alpha').raw().toBuffer();
if (!alpha.some((value) => value > 0)) throw new Error('The icon mark is empty.');
for (let pixel = 0; pixel < alpha.length; pixel++) {
  if (!alpha[pixel]) continue;
  const x = pixel % size + 0.5 - size / 2;
  const y = Math.floor(pixel / size) + 0.5 - size / 2;
  if (Math.hypot(x, y) > size * 33 / 108) {
    throw new Error('The essential mark exceeds the Android 66dp safe circle.');
  }
}
const foreground = await sharp({ create: { width: size, height: size, channels: 4, background: '#00000000' } })
  .composite([{ input: await shadow(680) }, { input: adaptiveMark }]).png().toBuffer();
const mainMark = await markLayer(960);
const composite = await sharp(background)
  .composite([{ input: await shadow(960) }, { input: mainMark }]).png().toBuffer();
const icon = await sharp(composite).removeAlpha().png().toBuffer();
const faviconMask = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="14" fill="white"/></svg>');
const favicon = await sharp(icon).resize(64, 64)
  .composite([{ input: faviconMask, blend: 'dest-in' }]).png().toBuffer();

const exports = [
  ['assets/images/icon.png', icon],
  ['assets/images/android-icon-background.png', background],
  ['assets/images/android-icon-foreground.png', foreground],
  ['assets/images/android-icon-monochrome.png', monochrome],
  ['assets/images/splash-icon.png', mainMark],
  ['assets/images/favicon.png', favicon],
  ['assets/expo.icon/Assets/remodr-mark.png', mainMark],
];

for (const [path, data] of exports) {
  const target = resolve(root, path);
  if (check) {
    if (!(await readFile(target)).equals(data)) {
      throw new Error(`${path} is stale. Run npm run assets:icons.`);
    }
  } else {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}
console.log(`${check ? 'Verified' : 'Generated'} ${exports.length} Remodr icon assets.`);

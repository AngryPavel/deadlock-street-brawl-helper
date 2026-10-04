// Render the editable SVG mark into the app/tray PNG and multi-size Windows ICO.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = await fs.readFile(path.join(root, 'build/icon.svg'));
await fs.writeFile(path.join(root, 'public/favicon.svg'), svg);
await sharp(svg).resize(180, 180).png().toFile(path.join(root, 'public/apple-touch-icon.png'));
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map((size) => sharp(svg).resize(size, size).png().toBuffer()));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
images.forEach((image, i) => {
  const entry = 6 + i * 16;
  header[entry] = header[entry + 1] = sizes[i] === 256 ? 0 : sizes[i];
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(image.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += image.length;
});
await fs.mkdir(path.join(root, 'build'), { recursive: true });
await fs.writeFile(path.join(root, 'build/icon.ico'), Buffer.concat([header, ...images]));

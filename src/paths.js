// DATA_DIR (default ./data). Missing files get copied from ./data.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED_DIR = path.join(ROOT, 'data');
export const DATA_DIR = path.resolve(process.env.DATA_DIR || SEED_DIR);

export function dataFile(name) {
  const file = path.join(DATA_DIR, name);
  if (!fs.existsSync(file) && DATA_DIR !== SEED_DIR && fs.existsSync(path.join(SEED_DIR, name))) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.copyFileSync(path.join(SEED_DIR, name), file);
  }
  return file;
}

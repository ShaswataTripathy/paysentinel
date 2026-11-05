// Where runtime data lives. Defaults to ./data; set DATA_DIR to keep state elsewhere (a mounted disk in
// production, a temp folder in tests). Missing files are seeded from the copies shipped in ./data.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED_DIR = path.join(ROOT, 'data');
export const DATA_DIR = path.resolve(process.env.DATA_DIR || SEED_DIR);

/** Absolute path of a data file, copying the shipped seed into DATA_DIR on first use. */
export function dataFile(name) {
  const file = path.join(DATA_DIR, name);
  if (!fs.existsSync(file) && DATA_DIR !== SEED_DIR && fs.existsSync(path.join(SEED_DIR, name))) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.copyFileSync(path.join(SEED_DIR, name), file);
  }
  return file;
}

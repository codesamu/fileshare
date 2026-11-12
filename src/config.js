import fs from 'node:fs';
import path from 'node:path';

// Minimal .env loader (no dependency). Values already in the environment win.
function loadDotEnv() {
  const file = path.join(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

const abs = (p, fallback) => path.resolve(p || fallback);

export const DATA_DIR = abs(process.env.DATA_DIR, './data');
export const BLOBS_DIR = path.join(DATA_DIR, 'blobs');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
export const INGEST_DIR = path.resolve(process.env.INGEST_DIR || path.join(DATA_DIR, 'ingest'));

export const PORT = Number(process.env.PORT || 8080);
export const HOST = process.env.HOST || '0.0.0.0';
export const SITE_NAME = (process.env.SITE_NAME || 'Home Drive').slice(0, 60);

const MB = 1024 * 1024;
export const CHUNK_SIZE = Math.min(Math.max(Number(process.env.CHUNK_SIZE_MB || 8) * MB, MB), 64 * MB);
export const MAX_UPLOAD_BYTES = Math.max(Number(process.env.MAX_UPLOAD_GB || 200), 1) * 1024 ** 3;
export const SESSION_DAYS = Math.max(Number(process.env.SESSION_DAYS || 30), 1);

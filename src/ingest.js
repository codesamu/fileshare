import fsp from 'node:fs/promises';
import path from 'node:path';
import { BLOBS_DIR, INGEST_DIR } from './config.js';
import { randomId, mimeFor, resolveInside } from './util.js';
import { getDb } from './db.js';

const SKIP = new Set(['@eaDir', '#recycle', 'System Volume Information', '.DS_Store', 'Thumbs.db']);

async function walk(dir, prefix, depth, out) {
  if (depth > 4 || out.length > 2000) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walk(abs, rel, depth + 1, out);
    } else if (entry.isFile()) {
      try {
        const stat = await fsp.stat(abs);
        out.push({ path: rel, name: entry.name, size: stat.size, mtime: stat.mtimeMs });
      } catch {
        /* file vanished while scanning */
      }
    }
    if (out.length > 2000) return;
  }
}

/** Files waiting in the Samba drop folder, newest first. */
export async function listIngest() {
  await fsp.mkdir(INGEST_DIR, { recursive: true });
  const found = [];
  await walk(INGEST_DIR, '', 0, found);
  const imported = new Map(
    getDb()
      .prepare('SELECT path, imported_at FROM ingest_log')
      .all()
      .map((row) => [row.path, row.imported_at])
  );
  found.sort((a, b) => b.mtime - a.mtime);
  return found.map((f) => ({ ...f, importedAt: imported.get(f.path) || null }));
}

/**
 * Move files from the drop folder into the library. On the same filesystem this
 * is a rename (instant, no copy), so a 15 GB file copied over SMB is available
 * in the web app immediately.
 */
export async function importPaths(relativePaths) {
  await fsp.mkdir(BLOBS_DIR, { recursive: true });
  const inserted = [];
  const errors = [];

  for (const rel of relativePaths.slice(0, 500)) {
    const abs = resolveInside(INGEST_DIR, rel);
    if (!abs) {
      errors.push({ path: rel, error: 'Invalid path' });
      continue;
    }
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat || !stat.isFile()) {
      errors.push({ path: rel, error: 'Not a file' });
      continue;
    }
    const name = path.basename(abs);
    const fileId = randomId(12);
    const blobRel = path.join(fileId.slice(0, 2), fileId);
    const blobAbs = path.join(BLOBS_DIR, blobRel);
    try {
      await fsp.mkdir(path.dirname(blobAbs), { recursive: true });
      try {
        await fsp.rename(abs, blobAbs);
      } catch (err) {
        if (err.code !== 'EXDEV') throw err;
        await fsp.copyFile(abs, blobAbs);
        await fsp.unlink(abs);
      }
      getDb()
        .prepare('INSERT INTO files (id, name, folder_id, size, mime, blob, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(fileId, name, null, stat.size, mimeFor(name), blobRel, Date.now());
      getDb()
        .prepare('INSERT INTO ingest_log (path, file_id, imported_at) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET file_id = excluded.file_id, imported_at = excluded.imported_at')
        .run(rel, fileId, Date.now());
      inserted.push({ id: fileId, name, size: stat.size });
    } catch (err) {
      errors.push({ path: rel, error: err.message });
    }
  }

  return { imported: inserted, errors };
}

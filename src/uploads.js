import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { TMP_DIR, BLOBS_DIR, CHUNK_SIZE, MAX_UPLOAD_BYTES } from './config.js';
import { randomId, mimeFor } from './util.js';
import { getDb } from './db.js';

/**
 * Resumable uploads.
 *
 * Each upload owns a sparse file pre-sized to the final length. A chunk request
 * is a plain PUT that pwrite()s its bytes at `index * CHUNK_SIZE`, so a 15 GB
 * file never has to be assembled or copied afterwards: finishing is a rename.
 * Because chunks are 8 MB by default, uploads also pass through Cloudflare's
 * 100 MB request-body limit.
 */
const uploads = new Map();

function statePathFor(id) {
  return path.join(TMP_DIR, id, 'state.json');
}

function partPathFor(id) {
  return path.join(TMP_DIR, id, 'file.part');
}

function publicView(upload) {
  return {
    uploadId: upload.id,
    name: upload.name,
    size: upload.size,
    chunkSize: upload.chunkSize,
    chunks: upload.chunks,
    received: [...upload.received].sort((a, b) => a - b),
  };
}

function persist(upload) {
  const snapshot = JSON.stringify({
    id: upload.id,
    name: upload.name,
    size: upload.size,
    folderId: upload.folderId,
    mime: upload.mime,
    chunkSize: upload.chunkSize,
    chunks: upload.chunks,
    received: [...upload.received],
    createdAt: upload.createdAt,
  });
  upload.saving = (upload.saving || Promise.resolve())
    .then(() => fsp.writeFile(upload.statePath, snapshot))
    .catch(() => {});
  return upload.saving;
}

export async function initUploads() {
  await fsp.mkdir(TMP_DIR, { recursive: true });
  await fsp.mkdir(BLOBS_DIR, { recursive: true });

  let entries = [];
  try {
    entries = await fsp.readdir(TMP_DIR, { withFileTypes: true });
  } catch {
    entries = [];
  }

  const cutoff = Date.now() - 7 * 86400_000;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statePath = statePathFor(entry.name);
    try {
      const state = JSON.parse(await fsp.readFile(statePath, 'utf8'));
      if (!state?.id || !state.size) throw new Error('bad state');
      if (state.createdAt < cutoff) throw new Error('stale');
      if (!fs.existsSync(partPathFor(state.id))) throw new Error('missing part');
      uploads.set(state.id, {
        ...state,
        received: new Set(state.received || []),
        statePath,
        partPath: partPathFor(state.id),
        saving: Promise.resolve(),
      });
    } catch {
      await fsp.rm(path.join(TMP_DIR, entry.name), { recursive: true, force: true });
    }
  }
}

export function getUpload(id) {
  return uploads.get(id) || null;
}

export async function createUpload({ name, size, folderId, resumeId }) {
  const cleanName = String(name || '').replace(/[\r\n/\\]/g, ' ').trim().slice(0, 200) || 'untitled';
  const total = Number(size);
  if (!Number.isFinite(total) || total < 0) throw httpError(400, 'Invalid file size');
  if (total > MAX_UPLOAD_BYTES) throw httpError(413, `File is larger than the ${Math.round(MAX_UPLOAD_BYTES / 1024 ** 3)} GB limit`);

  if (resumeId && uploads.has(resumeId)) {
    const existing = uploads.get(resumeId);
    if (existing.name === cleanName && existing.size === total) {
      existing.folderId = folderId ?? existing.folderId;
      return publicView(existing);
    }
  }

  const id = randomId(8);
  const dir = path.join(TMP_DIR, id);
  await fsp.mkdir(dir, { recursive: true });
  const partPath = partPathFor(id);
  await fsp.writeFile(partPath, '');
  // Sparse pre-allocation: chunk writes land at their final offset.
  await fsp.truncate(partPath, total);

  const upload = {
    id,
    name: cleanName,
    size: total,
    folderId: folderId || null,
    mime: mimeFor(cleanName),
    chunkSize: CHUNK_SIZE,
    chunks: Math.max(1, Math.ceil(total / CHUNK_SIZE)),
    received: new Set(),
    createdAt: Date.now(),
    statePath: statePathFor(id),
    partPath,
    saving: Promise.resolve(),
  };
  uploads.set(id, upload);
  await persist(upload);
  return publicView(upload);
}

export async function writeChunk(id, index, req) {
  const upload = uploads.get(id);
  if (!upload) throw httpError(404, 'Upload not found');
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= upload.chunks) throw httpError(400, 'Chunk index out of range');

  const offset = i * upload.chunkSize;
  const maxLength = Math.min(upload.chunkSize, upload.size - offset);
  if (maxLength <= 0) {
    // Zero-byte files still have a single (empty) chunk.
    upload.received.add(i);
    await persist(upload);
    return { received: upload.received.size, chunks: upload.chunks };
  }

  let received = 0;
  const sink = fs.createWriteStream(upload.partPath, { flags: 'r+', start: offset });
  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      sink.destroy();
      reject(err);
    };
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > maxLength) fail(httpError(413, 'Chunk is larger than declared'));
    });
    req.on('aborted', () => fail(httpError(400, 'Upload aborted')));
    req.on('error', fail);
    sink.on('error', fail);
    sink.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    req.pipe(sink);
  });
  if (received !== maxLength) throw httpError(400, `Chunk has ${received} bytes, expected ${maxLength}`);

  upload.received.add(i);
  await persist(upload);
  return { received: upload.received.size, chunks: upload.chunks };
}

export async function completeUpload(id) {
  const upload = uploads.get(id);
  if (!upload) throw httpError(404, 'Upload not found');

  if (upload.received.size !== upload.chunks) {
    throw httpError(400, `Upload incomplete (${upload.received.size}/${upload.chunks} chunks)`);
  }

  const stat = await fsp.stat(upload.partPath);
  if (stat.size !== upload.size) throw httpError(400, 'Uploaded size does not match the declared size');

  const fileId = randomId(12);
  const shard = fileId.slice(0, 2);
  const blobRel = path.join(shard, fileId);
  const blobAbs = path.join(BLOBS_DIR, blobRel);
  await fsp.mkdir(path.dirname(blobAbs), { recursive: true });
  await fsp.rename(upload.partPath, blobAbs);

  getDb()
    .prepare('INSERT INTO files (id, name, folder_id, size, mime, blob, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(fileId, upload.name, upload.folderId || null, upload.size, upload.mime, blobRel, Date.now());

  await cancelUpload(id);
  return {
    id: fileId,
    name: upload.name,
    size: upload.size,
    mime: upload.mime,
    folderId: upload.folderId || null,
    createdAt: Date.now(),
  };
}

export async function cancelUpload(id) {
  const upload = uploads.get(id);
  uploads.delete(id);
  await fsp.rm(path.join(TMP_DIR, id), { recursive: true, force: true });
  return upload || null;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

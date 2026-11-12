import {
  $,
  api,
  copyText,
  downloadUrl,
  escapeHtml,
  fmtBytes,
  fmtDate,
  fmtDateTime,
  icon,
} from './common.js';

const els = {
  boot: $('#boot'),
  login: $('#login'),
  app: $('#app'),
  content: $('#content'),
  crumbs: $('#crumbs'),
  fileInput: $('#file-input'),
  uploads: $('#uploads'),
  toast: $('#toast'),
  dropHint: $('#drop-hint'),
  modalRoot: $('#modal-root'),
  loginForm: $('#login-form'),
  loginError: $('#login-error'),
  loginPassword: $('#login-password'),
  newFolder: $('#new-folder'),
  uploadBtn: $('#upload-btn'),
  nav: $('#nav'),
  usageFill: $('#usage-fill'),
  usageText: $('#usage-text'),
};

const state = {
  config: null,
  route: 'files',
  folderId: null,
  folders: [],
  files: [],
  totals: { files: 0, size: 0 },
};

/* ---------------- boot & auth ---------------- */

async function boot() {
  try {
    const config = await fetch('/api/config').then((r) => r.json());
    state.config = config;
    document.title = config.siteName;
    $('#brand-name').textContent = config.siteName;
    $('#login-title').textContent = config.siteName;
    if (config.authenticated) startApp();
    else showLogin();
  } catch {
    els.boot.innerHTML = '<p class="muted">Could not reach the server.</p>';
  }
}

function showLogin() {
  els.boot.classList.add('hidden');
  els.app.classList.add('hidden');
  els.login.classList.remove('hidden');
  setTimeout(() => els.loginPassword.focus(), 50);
}

function startApp() {
  els.boot.classList.add('hidden');
  els.login.classList.add('hidden');
  els.app.classList.remove('hidden');
  renderRoute();
}

els.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  els.loginError.textContent = '';
  const button = els.loginForm.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    await api('/api/login', { method: 'POST', body: { password: els.loginPassword.value } });
    els.loginPassword.value = '';
    startApp();
  } catch (err) {
    els.loginError.textContent = err.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Unlock drive';
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.hash = '';
  showLogin();
});

/* ---------------- modal helpers ---------------- */

function openModal({ title, html, wide = false, footer = '', onClose = null }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">
      <header class="modal-head">
        <h2></h2>
        <button class="icon-btn" data-modal-close aria-label="Close">${icon('close')}</button>
      </header>
      <div class="modal-body"></div>
      ${footer ? `<footer class="modal-foot">${footer}</footer>` : ''}
    </div>`;
  backdrop.querySelector('h2').textContent = title;
  const body = backdrop.querySelector('.modal-body');
  if (typeof html === 'string') body.innerHTML = html;
  else if (html) body.append(html);

  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop || event.target.closest('[data-modal-close]')) close();
  });
  els.modalRoot.append(backdrop);
  return { el: backdrop, body, close };
}

function promptModal({ title, label, value = '', confirmText = 'Save' }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      modal.close();
      resolve(result);
    };
    const modal = openModal({
      title,
      html: `<label class="field"><span>${escapeHtml(label)}</span>
        <input id="prompt-input" value="${escapeHtml(value)}" autocomplete="off" spellcheck="false"></label>`,
      footer: `<button class="btn ghost" data-cancel>Cancel</button>
        <button class="btn primary" data-confirm>${escapeHtml(confirmText)}</button>`,
      onClose: () => finish(null),
    });
    const input = modal.body.querySelector('#prompt-input');
    modal.el.querySelector('[data-confirm]').addEventListener('click', () => finish(input.value.trim() || null));
    modal.el.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(input.value.trim() || null);
      }
    });
    input.focus();
    const dot = input.value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  });
}

function confirmModal({ title, message, confirmText = 'Delete', danger = true }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      modal.close();
      resolve(result);
    };
    const modal = openModal({
      title,
      html: `<p class="modal-text">${escapeHtml(message)}</p>`,
      footer: `<button class="btn ghost" data-cancel>Cancel</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-confirm>${escapeHtml(confirmText)}</button>`,
      onClose: () => finish(false),
    });
    modal.el.querySelector('[data-confirm]').addEventListener('click', () => finish(true));
    modal.el.querySelector('[data-cancel]').addEventListener('click', () => finish(false));
  });
}

/* ---------------- toast ---------------- */

let toastTimer;
function toast(message, type = '') {
  els.toast.textContent = message;
  els.toast.className = `toast ${type}`;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 4200);
}

/* ---------------- routing ---------------- */

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [route, ...rest] = raw.split('/').filter(Boolean);
  return { route: route || 'files', rest };
}

function navigate(hash) {
  if (location.hash === hash) renderRoute();
  else location.hash = hash;
}

async function renderRoute() {
  if (!state.config?.authenticated && state.config) {
    const { authenticated } = await api('/api/session').catch(() => ({ authenticated: false }));
    if (!authenticated) return showLogin();
  }
  const { route, rest } = parseHash();
  state.route = ['shares', 'ingest'].includes(route) ? route : 'files';
  for (const button of els.nav.querySelectorAll('[data-nav]')) {
    button.classList.toggle('active', button.dataset.nav === state.route);
  }
  els.newFolder.classList.toggle('hidden', state.route !== 'files');
  els.uploadBtn.classList.toggle('hidden', state.route !== 'files');

  try {
    if (state.route === 'shares') await renderSharesView();
    else if (state.route === 'ingest') await renderIngestView();
    else {
      state.folderId = rest[0] ? decodeURIComponent(rest[0]) : null;
      await renderFilesView();
    }
  } catch (err) {
    if (err.status === 401) return showLogin();
    els.content.innerHTML = `<div class="empty"><h2>Something went wrong</h2><p class="muted">${escapeHtml(err.message)}</p></div>`;
  }
}

window.addEventListener('hashchange', renderRoute);
els.nav.addEventListener('click', (event) => {
  const button = event.target.closest('[data-nav]');
  if (button) navigate(button.dataset.nav === 'files' ? '#/files' : `#/${button.dataset.nav}`);
});

/* ---------------- files view ---------------- */

function folderRow(folder) {
  return `<div class="row" data-kind="folder" data-id="${folder.id}">
    <span class="tile tile-folder">${icon('folder')}</span>
    <div class="name-cell">
      <span class="name">${escapeHtml(folder.name)}</span>
      <span class="sub">${folder.fileCount} file${folder.fileCount === 1 ? '' : 's'}${folder.size ? ` · ${fmtBytes(folder.size)}` : ''}</span>
    </div>
    <span class="col-size">—</span>
    <span class="col-date">${fmtDate(folder.createdAt)}</span>
    <span class="row-actions">
      <button class="icon-btn" data-action="share" title="Create share link">${icon('link')}</button>
      <button class="icon-btn" data-action="rename" title="Rename">${icon('edit')}</button>
      <button class="icon-btn danger" data-action="delete" title="Delete">${icon('trash')}</button>
    </span>
  </div>`;
}

function fileRow(file) {
  const ext = (file.name.match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'file').toUpperCase().slice(0, 4);
  return `<div class="row" data-kind="file" data-id="${file.id}">
    <span class="tile tile-${file.kind}">${ext}</span>
    <div class="name-cell">
      <span class="name">${escapeHtml(file.name)}</span>
      <span class="sub">${escapeHtml(file.mime)}</span>
    </div>
    <span class="col-size">${fmtBytes(file.size)}</span>
    <span class="col-date">${fmtDate(file.createdAt)}</span>
    <span class="row-actions">
      ${file.kind !== 'other' ? `<button class="icon-btn" data-action="preview" title="Preview">${icon('eye')}</button>` : ''}
      <button class="icon-btn" data-action="download" title="Download">${icon('download')}</button>
      <button class="icon-btn" data-action="share" title="Create share link">${icon('link')}</button>
      <button class="icon-btn" data-action="rename" title="Rename">${icon('edit')}</button>
      <button class="icon-btn danger" data-action="delete" title="Delete">${icon('trash')}</button>
    </span>
  </div>`;
}

function renderCrumbs(breadcrumb) {
  const parts = [`<button class="crumb" data-crumb="root">${escapeHtml(state.config?.siteName || 'Files')}</button>`];
  for (const crumb of breadcrumb) {
    parts.push(`<span class="sep">/</span>`);
    parts.push(`<button class="crumb" data-crumb="${crumb.id}">${escapeHtml(crumb.name)}</button>`);
  }
  els.crumbs.innerHTML = parts.join('');
}

function updateUsage() {
  const { files, size } = state.totals;
  els.usageText.textContent = `${files} file${files === 1 ? '' : 's'} · ${fmtBytes(size)} stored`;
  els.usageFill.style.width = `${Math.min(100, (size / (200 * 1024 ** 3)) * 100)}%`;
}

async function renderFilesView() {
  els.content.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
  const data = await api(`/api/browse?folder=${encodeURIComponent(state.folderId || 'root')}`);
  state.folders = data.folders;
  state.files = data.files;
  state.totals = data.totals;
  state.folderId = data.folder?.id || null;
  renderCrumbs(data.breadcrumb);
  updateUsage();

  const title = data.folder ? data.folder.name : 'All files';
  const total = data.folders.length + data.files.length;
  const rows = data.folders.map(folderRow).join('') + data.files.map(fileRow).join('');

  els.content.innerHTML = `
    <div class="section-head">
      <div>
        <h1>${escapeHtml(title)}</h1>
        <p class="muted small">${total} item${total === 1 ? '' : 's'}</p>
      </div>
    </div>
    ${
      rows
        ? `<div class="list">
             <div class="list-head">
               <span></span><span>Name</span><span class="col-size">Size</span>
               <span class="col-date">Added</span><span></span>
             </div>
             ${rows}
           </div>`
        : `<div class="empty">
             <div class="empty-art">${icon('folder')}</div>
             <h2>Nothing here yet</h2>
             <p class="muted">Drag files in, or upload them. Large files are sent in resumable chunks.</p>
             <button class="btn primary" data-empty-upload>Upload files</button>
           </div>`
    }`;
}

function currentItem(id) {
  return state.files.find((file) => file.id === id) || state.folders.find((folder) => folder.id === id) || null;
}

els.content.addEventListener('click', (event) => {
  const crumb = event.target.closest('[data-crumb]');
  if (crumb) {
    navigate(crumb.dataset.crumb === 'root' ? '#/files' : `#/files/${crumb.dataset.crumb}`);
    return;
  }
  if (event.target.closest('[data-empty-upload]')) {
    els.fileInput.click();
    return;
  }
  const actionButton = event.target.closest('[data-action]');
  const row = event.target.closest('.row');
  if (row) {
    if (actionButton) {
      event.stopPropagation();
      handleRowAction(actionButton.dataset.action, row);
      return;
    }
    if (row.dataset.kind === 'folder') navigate(`#/files/${row.dataset.id}`);
    else {
      const file = currentItem(row.dataset.id);
      if (file) {
        if (file.kind === 'other') downloadUrl(`/api/files/${file.id}/stream?dl=1`);
        else openPreview(file);
      }
    }
    return;
  }
  const nav = event.target.closest('[data-nav-action]');
  if (nav) handleNavAction(nav);
});

async function handleRowAction(action, row) {
  const kind = row.dataset.kind;
  const item = currentItem(row.dataset.id);
  if (!item) return;

  if (action === 'preview') return openPreview(item);
  if (action === 'download') return downloadUrl(`/api/files/${item.id}/stream?dl=1`);
  if (action === 'share') return openShareDialog(kind, item);

  if (action === 'rename') {
    const name = await promptModal({ title: 'Rename', label: 'Name', value: item.name, confirmText: 'Rename' });
    if (!name || name === item.name) return;
    try {
      await api(`/api/items/${item.id}`, { method: 'PATCH', body: { name, kind } });
      toast('Renamed', 'ok');
      renderRoute();
    } catch (err) {
      toast(err.message, 'bad');
    }
    return;
  }

  if (action === 'delete') {
    const ok = await confirmModal({
      title: kind === 'folder' ? 'Delete folder?' : 'Delete file?',
      message:
        kind === 'folder'
          ? `"${item.name}" and everything inside it will be permanently removed from the server.`
          : `"${item.name}" will be permanently removed from the server.`,
      confirmText: 'Delete',
    });
    if (!ok) return;
    try {
      await api(`/api/items/${item.id}?kind=${kind}`, { method: 'DELETE' });
      toast('Deleted', 'ok');
      renderRoute();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }
}

/* ---------------- preview ---------------- */

function openPreview(file) {
  const src = `/api/files/${file.id}/stream`;
  let media = `<p class="muted">No preview available for this file type.</p>`;
  if (file.kind === 'image') media = `<img class="preview-media" src="${src}" alt="${escapeHtml(file.name)}">`;
  else if (file.kind === 'video') media = `<video class="preview-media" src="${src}" controls autoplay playsinline></video>`;
  else if (file.kind === 'audio') media = `<div class="preview-audio"><audio src="${src}" controls autoplay></audio></div>`;
  else if (file.kind === 'pdf') media = `<iframe class="preview-frame" src="${src}" title="${escapeHtml(file.name)}"></iframe>`;
  else if (file.kind === 'text') media = `<pre class="preview-text" id="preview-text">Loading…</pre>`;

  const modal = openModal({
    title: file.name,
    wide: true,
    html: `<div class="preview">${media}</div>`,
    footer: `<span class="muted small">${fmtBytes(file.size)} · added ${fmtDate(file.createdAt)}</span>
      <a class="btn primary" href="${src}?dl=1" download>${icon('download')} Download</a>`,
  });

  if (file.kind === 'text') {
    fetch(`/api/files/${file.id}/text`)
      .then((response) => response.json())
      .then((data) => {
        const pre = modal.body.querySelector('#preview-text');
        if (!pre) return;
        pre.textContent = data.text || '(empty file)';
        if (data.truncated) pre.insertAdjacentHTML('afterend', '<p class="muted small">Preview truncated — download for the whole file.</p>');
      })
      .catch(() => {
        const pre = modal.body.querySelector('#preview-text');
        if (pre) pre.textContent = 'Could not load the file.';
      });
  }
}

/* ---------------- share dialog ---------------- */

function openShareDialog(kind, item) {
  const modal = openModal({
    title: kind === 'folder' ? 'Share folder' : 'Share file',
    html: `
      <p class="modal-text">Anyone with the link can download <strong>${escapeHtml(item.name)}</strong>. No account needed.</p>
      <div class="share-result hidden" id="share-result">
        <label class="field"><span>Link</span>
          <div class="copy-row">
            <input id="share-url" readonly>
            <button class="btn ghost" id="copy-url" type="button">${icon('copy')} Copy</button>
          </div>
        </label>
        <p class="muted small" id="share-hint"></p>
      </div>
      <div class="form-grid">
        <label class="field"><span>Password <em class="muted">(optional)</em></span>
          <input id="share-password" type="text" autocomplete="off" placeholder="Leave empty for no password"></label>
        <label class="field"><span>Expires</span>
          <select id="share-expiry">
            <option value="0">Never</option>
            <option value="1">In 1 day</option>
            <option value="7" selected>In 7 days</option>
            <option value="30">In 30 days</option>
          </select></label>
        <label class="field"><span>Download limit <em class="muted">(optional)</em></span>
          <input id="share-max" type="number" min="0" placeholder="Unlimited"></label>
      </div>`,
    footer: `<button class="btn ghost" data-modal-close>Done</button>
      <button class="btn primary" id="create-share">Create link</button>`,
  });

  modal.el.querySelector('#create-share').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Creating…';
    try {
      const share = await api('/api/shares', {
        method: 'POST',
        body: {
          itemId: item.id,
          kind,
          name: item.name,
          password: modal.el.querySelector('#share-password').value.trim(),
          expiresInDays: Number(modal.el.querySelector('#share-expiry').value),
          maxDownloads: Number(modal.el.querySelector('#share-max').value) || 0,
        },
      });
      modal.el.querySelector('#share-result').classList.remove('hidden');
      modal.el.querySelector('#share-url').value = share.url;
      modal.el.querySelector('#share-hint').textContent = `${
        share.hasPassword ? 'Password protected · ' : ''
      }${share.expiresAt ? `expires ${fmtDate(share.expiresAt)}` : 'no expiry'} · ${share.fileCount} file${
        share.fileCount === 1 ? '' : 's'
      }`;
      button.textContent = 'Link ready';
      button.classList.remove('primary');
      await copyText(share.url);
      toast('Link copied to clipboard', 'ok');
      const again = await confirmModal({
        title: 'Link ready',
        message: 'The link is on your clipboard. You can manage or revoke it later under Shared links.',
        confirmText: 'See all links',
        danger: false,
      });
      if (again) navigate('#/shares');
    } catch (err) {
      toast(err.message, 'bad');
      button.disabled = false;
      button.textContent = 'Create link';
    }
  });

  modal.el.querySelector('#copy-url').addEventListener('click', async () => {
    const url = modal.el.querySelector('#share-url').value;
    if (await copyText(url)) toast('Copied', 'ok');
  });
}

/* ---------------- shares view ---------------- */

function shareCard(share) {
  const expired = share.blocked;
  return `<article class="card ${expired ? 'dim' : ''}">
    <div class="card-top">
      <span class="tile tile-${share.kind === 'folder' ? 'folder' : 'other'}">${
        share.kind === 'folder' ? icon('folder') : icon('file')
      }</span>
      <div class="card-title">
        <h3>${escapeHtml(share.name)}</h3>
        <p class="muted small">${share.fileCount} file${share.fileCount === 1 ? '' : 's'} · ${fmtBytes(share.totalSize)}</p>
      </div>
      <span class="badge ${expired ? 'bad' : share.hasPassword ? 'warn' : 'ok'}">${
        expired ? 'Inactive' : share.hasPassword ? 'Password' : 'Public'
      }</span>
    </div>
    <div class="copy-row">
      <input readonly value="${escapeHtml(share.url)}" aria-label="Share URL">
      <button class="icon-btn" data-action="copy-link" data-url="${escapeHtml(share.url)}" title="Copy link">${icon('copy')}</button>
      <a class="icon-btn" href="${escapeHtml(share.url)}" target="_blank" rel="noopener" title="Open">${icon('external')}</a>
    </div>
    <div class="card-meta muted small">
      <span>${share.downloads} download${share.downloads === 1 ? '' : 's'}${
        share.maxDownloads ? ` of ${share.maxDownloads}` : ''
      }</span>
      <span>${share.expiresAt ? `expires ${fmtDate(share.expiresAt)}` : 'no expiry'}</span>
      <span>created ${fmtDate(share.createdAt)}</span>
    </div>
    <div class="card-actions">
      <button class="btn ghost small danger-text" data-action="delete-share" data-id="${share.id}">${icon('trash')} Revoke</button>
    </div>
  </article>`;
}

async function renderSharesView() {
  els.content.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
  els.crumbs.innerHTML = '<span class="crumb static">Shared links</span>';
  const { shares } = await api('/api/shares');
  els.content.innerHTML = `
    <div class="section-head">
      <div>
        <h1>Shared links</h1>
        <p class="muted small">Public download links. Revoke one at any time.</p>
      </div>
    </div>
    ${
      shares.length
        ? `<div class="cards">${shares.map(shareCard).join('')}</div>`
        : `<div class="empty">
             <div class="empty-art">${icon('link')}</div>
             <h2>No links yet</h2>
             <p class="muted">Open a file or folder and use the link button to share it with someone.</p>
             <button class="btn primary" data-nav-action="files">Go to files</button>
           </div>`
    }`;
}

async function handleNavAction(button) {
  if (button.dataset.navAction === 'files') navigate('#/files');
}

/* ---------------- ingest view ---------------- */

async function renderIngestView() {
  els.content.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
  els.crumbs.innerHTML = '<span class="crumb static">Import from Samba</span>';
  const data = await api('/api/ingest');
  const files = data.files;

  const rows = files
    .map(
      (file, index) => `<label class="pick-row">
        <input type="checkbox" data-ingest-path="${escapeHtml(file.path)}" id="ingest-${index}" ${
          file.importedAt ? '' : 'checked'
        }>
        <span class="tile tile-other">${(file.name.match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'file').toUpperCase().slice(0, 4)}</span>
        <span class="name-cell">
          <span class="name">${escapeHtml(file.path)}</span>
          <span class="sub">${fmtBytes(file.size)} · modified ${fmtDateTime(file.mtime)}</span>
        </span>
        ${file.importedAt ? '<span class="badge ok">imported</span>' : ''}
      </label>`
    )
    .join('');

  els.content.innerHTML = `
    <div class="section-head">
      <div>
        <h1>Import from Samba</h1>
        <p class="muted small">Copy files into the drop folder from your computer, then import them here.</p>
      </div>
      <div class="head-actions">
        <button class="btn ghost" data-nav-action="refresh-ingest">${icon('refresh')} Refresh</button>
        <button class="btn primary" id="do-import" ${files.length ? '' : 'disabled'}>Import selected</button>
      </div>
    </div>
    <div class="note">
      <code>${escapeHtml(data.dir)}</code>
      <p class="muted small">Importing moves files into the library — instantly on the same disk, no copy.</p>
    </div>
    ${
      files.length
        ? `<div class="list pick-list">
             <div class="list-head"><span><input type="checkbox" id="pick-all" checked aria-label="Select all"></span>
               <span>File</span><span></span></div>
             ${rows}
           </div>`
        : `<div class="empty">
             <div class="empty-art">${icon('inbox')}</div>
             <h2>Drop folder is empty</h2>
             <p class="muted">Copy files into <code>${escapeHtml(data.dir)}</code> over Samba, then refresh.</p>
           </div>`
    }`;

  els.content.querySelector('[data-nav-action="refresh-ingest"]')?.addEventListener('click', renderIngestView);
  els.content.querySelector('#pick-all')?.addEventListener('change', (event) => {
    for (const box of els.content.querySelectorAll('[data-ingest-path]')) box.checked = event.target.checked;
  });
  els.content.querySelector('#do-import')?.addEventListener('click', async (event) => {
    const paths = [...els.content.querySelectorAll('[data-ingest-path]')]
      .filter((box) => box.checked)
      .map((box) => box.dataset.ingestPath);
    if (!paths.length) return toast('Nothing selected', 'bad');
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Importing…';
    try {
      const result = await api('/api/ingest/import', { method: 'POST', body: { paths } });
      toast(`Imported ${result.imported.length} file${result.imported.length === 1 ? '' : 's'}`, 'ok');
      if (result.errors.length) toast(`${result.errors.length} could not be imported`, 'bad');
      renderIngestView();
    } catch (err) {
      toast(err.message, 'bad');
      button.disabled = false;
      button.textContent = 'Import selected';
    }
  });
}

/* ---------------- create folder / pick files ---------------- */

els.newFolder.addEventListener('click', async () => {
  const name = await promptModal({ title: 'New folder', label: 'Folder name', value: '', confirmText: 'Create' });
  if (!name) return;
  try {
    await api('/api/folders', { method: 'POST', body: { name, parentId: state.folderId } });
    renderFilesView();
  } catch (err) {
    toast(err.message, 'bad');
  }
});

els.uploadBtn.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files?.length) enqueue([...els.fileInput.files]);
  els.fileInput.value = '';
});

/* ---------------- uploads ---------------- */

const MAX_PARALLEL_FILES = 2;
const CHUNK_LANES = 4;
const queue = [];
let activeUploads = 0;
let openUploadItems = 0;

function enqueue(files) {
  if (!files.length) return;
  const folderId = state.route === 'files' ? state.folderId : null;
  for (const file of files) queue.push({ file, folderId });
  pump();
}

function pump() {
  while (activeUploads < MAX_PARALLEL_FILES && queue.length) {
    const job = queue.shift();
    activeUploads += 1;
    uploadOne(job.file, job.folderId)
      .catch((err) => toast(`${job.file.name}: ${err.message}`, 'bad'))
      .finally(() => {
        activeUploads -= 1;
        pump();
      });
  }
}

function uploadItem(name) {
  const el = document.createElement('div');
  el.className = 'upload-item';
  el.innerHTML = `
    <div class="upload-top">
      <span class="upload-name"></span>
      <span class="upload-pct">0%</span>
    </div>
    <div class="bar"><span></span></div>
    <div class="upload-meta">
      <span class="upload-status">Starting…</span>
      <span class="upload-speed"></span>
    </div>`;
  el.querySelector('.upload-name').textContent = name;
  els.uploads.append(el);
  els.uploads.hidden = false;
  openUploadItems += 1;
  return el;
}

function closeUploadItem(el, delay = 2600) {
  openUploadItems -= 1;
  setTimeout(() => {
    el.remove();
    if (openUploadItems <= 0) {
      openUploadItems = 0;
      els.uploads.hidden = true;
    }
  }, delay);
}

function paintProgress(el, { pct, sent, total, speed, status }) {
  el.querySelector('.bar > span').style.width = `${Math.max(0.5, Math.min(100, pct)).toFixed(1)}%`;
  el.querySelector('.upload-pct').textContent = `${Math.floor(Math.min(100, pct))}%`;
  if (status) {
    el.querySelector('.upload-status').textContent = `${status} · ${fmtBytes(sent)} of ${fmtBytes(total)}`;
  }
  el.querySelector('.upload-speed').textContent = speed > 0 ? `${fmtBytes(speed)}/s` : '';
}

async function uploadOne(file, folderId) {
  const el = uploadItem(file.name);
  const key = `hd-upload:${folderId || 'root'}:${file.name}:${file.size}:${file.lastModified}`;

  try {
    const upload = await api('/api/uploads', {
      method: 'POST',
      body: {
        name: file.name,
        size: file.size,
        folderId,
        resumeId: localStorage.getItem(key) || undefined,
      },
    });
    localStorage.setItem(key, upload.uploadId);

    const received = new Set(upload.received || []);
    const pending = [];
    for (let i = 0; i < upload.chunks; i += 1) if (!received.has(i)) pending.push(i);

    let sent = 0;
    for (const index of received) sent += Math.min(upload.chunkSize, Math.max(0, upload.size - index * upload.chunkSize));
    const startSent = sent;
    const startedAt = Date.now();

    const paint = (status) => {
      const pct = upload.size ? (sent / upload.size) * 100 : 100;
      const elapsed = (Date.now() - startedAt) / 1000;
      const speed = elapsed > 0.8 ? (sent - startSent) / elapsed : 0;
      paintProgress(el, { pct, sent, total: upload.size, speed, status });
    };
    if (received.size) paint(`Resuming (${received.size}/${upload.chunks})`);
    else paint('Uploading');

    let cursor = 0;
    const lane = async () => {
      while (cursor < pending.length) {
        const index = pending[cursor];
        cursor += 1;
        const start = index * upload.chunkSize;
        const end = Math.min(start + upload.chunkSize, upload.size);
        const response = await fetch(`/api/uploads/${upload.uploadId}/${index}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file.slice(start, end),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || `Chunk ${index} failed (${response.status})`);
        }
        sent += end - start;
        paint('Uploading');
      }
    };
    await Promise.all(Array.from({ length: Math.min(CHUNK_LANES, Math.max(pending.length, 1)) }, lane));

    await api(`/api/uploads/${upload.uploadId}/complete`, { method: 'POST' });
    localStorage.removeItem(key);
    el.classList.add('done');
    paintProgress(el, { pct: 100, sent: upload.size, total: upload.size, speed: 0, status: 'Uploaded' });
    closeUploadItem(el);
    if (state.route === 'files' && (state.folderId || null) === (folderId || null)) renderFilesView();
  } catch (err) {
    el.classList.add('failed');
    el.querySelector('.upload-status').textContent = `Failed — ${err.message}`;
    el.querySelector('.upload-pct').textContent = 'Retry';
    el.querySelector('.upload-top').addEventListener('click', () => {
      queue.push({ file, folderId });
      pump();
    });
    closeUploadItem(el, 120000);
    throw err;
  }
}

/* ---------------- drag & drop ---------------- */

const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');
let dragDepth = 0;

window.addEventListener('dragenter', (event) => {
  if (!hasFiles(event) || els.app.classList.contains('hidden')) return;
  event.preventDefault();
  dragDepth += 1;
  els.dropHint.classList.add('active');
});
window.addEventListener('dragover', (event) => {
  if (hasFiles(event)) event.preventDefault();
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) els.dropHint.classList.remove('active');
});
window.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  els.dropHint.classList.remove('active');
  if (state.route !== 'files') {
    navigate('#/files');
    toast('Dropped files go to the folder you are viewing — switched to All files', '');
  }
  enqueue([...(event.dataTransfer?.files || [])]);
});

boot();

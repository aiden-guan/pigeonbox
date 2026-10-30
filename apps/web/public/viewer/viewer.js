// Only a rendered, visible, focused page creates a view. Bytes and observations stay on the
// issuing API origin; no cookies, fingerprints or third-party analytics.
import * as pdfjs from './pdfjs/pdf.min.mjs';
import { DocumentActivity, DocumentActivityJournal } from './activity.js?v=3';

const ASSETS = new URL('./pdfjs/', import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', ASSETS).href;
const root = document.querySelector('main.viewer');
const pagesEl = document.getElementById('pages');
const base = `/d/${encodeURIComponent(root?.dataset.token ?? '')}`;
const watermark = root?.dataset.watermark ?? '';
const retryButton = document.getElementById('retry-document');
const progress = document.getElementById('viewer-status');
const trackingStatus = document.getElementById('tracking-status');
const download = document.querySelector('.download');
const nativeButton = document.getElementById('native-pdf');
const pageNumber = document.getElementById('page-number');
const pageCount = document.getElementById('page-count');
const previousPage = document.getElementById('previous-page');
const nextPage = document.getElementById('next-page');
const zoom = document.getElementById('zoom');
const zoomIn = document.getElementById('zoom-in');
const zoomOut = document.getElementById('zoom-out');
const preview = new URLSearchParams(location.hash.slice(1)).get('preview');
const wasPreview = Boolean(preview || history.state?.documentPreview);
const viewerSessionKey = `pigeonbox.document-session:${root?.dataset.token ?? ''}`;
const previewSessionKey = `pigeonbox.document-preview:${root?.dataset.token ?? ''}`;
if (location.hash) history.replaceState({ documentPreview: wasPreview }, '', location.pathname);
let session;
let activity;
let stopped = false;
let opening = false;
let nativeUrl;
let deliveryIncomplete = false;
let journal;
try { journal = new DocumentActivityJournal({ storage: localStorage, scope: base }); } catch { deliveryIncomplete = true; }
let releaseViewer = () => {};
const showTracking = message => { trackingStatus.textContent = message; };
function stop() {
  if (stopped) return;
  stopped = true; activity?.stop();
  progress.textContent = ''; retryButton.hidden = true;
  pagesEl.setAttribute('aria-busy', 'false');
  pagesEl.replaceChildren(Object.assign(document.createElement('p'), { className: 'status', textContent: 'This link is no longer available. Close this page or ask the sender for a new link.' }));
  for (const control of [nativeButton, pageNumber, previousPage, nextPage, zoom, zoomIn, zoomOut]) if (control) control.disabled = true;
  download?.remove();
  releaseViewer();
}
async function send(payload) {
  const response = await fetch(`${base}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), keepalive: true, credentials: 'omit', signal: AbortSignal.timeout(10_000) });
  if ([403, 404].includes(response.status)) {
    if (payload.sessionId === session?.sessionId) stop();
    else { try { journal?.remove({ sessionId: payload.sessionId }); } catch { /* Expired credentials are never replayed again. */ } }
    return;
  }
  if (!response.ok) throw new Error('Activity delivery failed');
  showTracking(session?.preview ? 'Sender preview — excluded from recipient activity.' : deliveryIncomplete ? 'Some activity may be incomplete. This browser could not retain every observation.' : 'The sender can see pages on screen and visible time.');
}
// Account tokens stay on this origin. Only sender-session credentials are
// retained in this tab so a reload cannot add recipient activity.
function ownerAuthorization() {
  try {
    const stored = JSON.parse(localStorage.getItem('pigeonbox.session') || sessionStorage.getItem('pigeonbox.session') || 'null');
    return typeof stored?.accessToken === 'string' ? { Authorization: `Bearer ${stored.accessToken}` } : {};
  } catch { return {}; }
}
async function openDocument() {
  if (opening || session || stopped) return;
  opening = true; retryButton.hidden = true; progress.textContent = 'Loading PDF…';
  pagesEl.setAttribute('aria-busy', 'true');
  let loadingTask;
  let loadTimer;
  try {
    let saved = null;
    try {
      // Only a reload resumes the current tab's recipient session. New tabs get
      // separate sessions/time budgets; old unacknowledged batches replay below.
      if (performance.getEntriesByType('navigation')[0]?.type === 'reload') saved = journal?.entry(sessionStorage.getItem(viewerSessionKey));
    } catch { deliveryIncomplete = true; }
    let resume = !wasPreview || saved?.session.preview ? saved?.session.sessionToken ?? null : null;
    if (!preview) {
      try { resume = sessionStorage.getItem(previewSessionKey) || resume; } catch { /* Storage may be disabled. */ }
    }
    if (wasPreview && !preview && !resume) throw new Error('Open a fresh sender preview from Documents or Gmail. This browser could not retain the preview session.');
    const response = await fetch(`${base}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(preview || resume ? {} : ownerAuthorization()) }, body: JSON.stringify(preview ? { preview } : resume ? { resume } : {}), credentials: 'omit', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) {
      if ([403, 404].includes(response.status)) throw new Error(preview || resume ? 'This preview expired. Open a new preview from Documents or Gmail.' : 'This link is no longer available.');
      if (response.status === 401) throw new Error('Your PigeonBox sign-in expired. Sign in again before opening this document.');
      throw new Error('The document could not open. Please try again.');
    }
    session = await response.json();
    try { sessionStorage.setItem(viewerSessionKey, session.sessionId); } catch { deliveryIncomplete = true; }
    if (session.preview) {
      history.replaceState({ documentPreview: true }, '', location.pathname);
      try { sessionStorage.setItem(previewSessionKey, session.sessionToken); } catch { /* Sender should reopen a fresh preview if tab storage is unavailable. */ }
    }
    // Replay older session-bound observations without holding up the document.
    // Each acknowledgement removes only its own IDs, preserving new events in
    // a still-open tab that shares this origin.
    try {
      for (const pending of (journal?.entries() ?? []).filter(value => value.session.sessionId !== session.sessionId && value.queue.length).slice(0,4)) {
        const replay = new DocumentActivity({ session: pending.session, send, journal, attentive: () => false, onFailure: () => { deliveryIncomplete = true; } });
        void replay.flush();
      }
    } catch { deliveryIncomplete = true; }
    activity = new DocumentActivity({ session, send, journal, attentive: () => !stopped && document.visibilityState === 'visible' && document.hasFocus(),
      onFailure: () => { deliveryIncomplete = true; showTracking('Activity delivery is delayed or incomplete. Saved observations retry on this page within eight hours.'); } });
    void activity.flush();
    if (stopped) return;
    loadingTask = pdfjs.getDocument({
      url: `${base}/file`, httpHeaders: { 'X-Document-Session': session.sessionToken },
      disableRange: true, disableStream: true, disableAutoFetch: true, withCredentials: false,
      enableXfa: false, isEvalSupported: false,
      cMapUrl: new URL('cmaps/', ASSETS).href, cMapPacked: true,
      standardFontDataUrl: new URL('standard_fonts/', ASSETS).href,
      wasmUrl: new URL('wasm/', ASSETS).href, iccUrl: new URL('iccs/', ASSETS).href,
    });
    const pdf = await Promise.race([loadingTask.promise, new Promise((_, reject) => {
      loadTimer = setTimeout(() => reject(new Error('The PDF took too long to load. Check your connection and try again.')), 30_000);
    })]);
    clearTimeout(loadTimer);
    if (stopped) { await loadingTask.destroy(); return; }
    if (pdf.numPages > 500 || pdf.numPages < 1) throw new Error('Choose a PDF with 1 to 500 pages.');
    showTracking(session?.preview ? 'Sender preview — excluded from recipient activity.' : 'Pages and time are measured only while this viewer is visible and focused.');
    await renderDocument(pdf);
    download?.removeAttribute('aria-disabled');
    if (nativeButton) {
      // Reuse the bytes already loaded for preview. Opening the original in the
      // browser's PDF viewer preserves vector/text printing and isn't a download event.
      nativeUrl = URL.createObjectURL(new Blob([await pdf.getData()], { type: 'application/pdf' }));
      if (stopped) { URL.revokeObjectURL(nativeUrl); return; }
      nativeButton.disabled = false;
    }
  } catch (error) {
    activity?.pause(); void activity?.flush(true); releaseViewer();
    await loadingTask?.destroy().catch(() => {});
    session = null; retryButton.hidden = stopped;
    for (const control of [nativeButton, pageNumber, previousPage, nextPage, zoom, zoomIn, zoomOut]) if (control) control.disabled = true;
    download?.setAttribute('aria-disabled', 'true');
    pagesEl.setAttribute('aria-busy', 'false');
    progress.textContent = ['TimeoutError', 'AbortError'].includes(error.name) ? 'The PDF took too long to load. Check your connection and try again.' : error.message || 'This document could not be displayed.';
  } finally { clearTimeout(loadTimer); opening = false; }
}
retryButton.addEventListener('click', openDocument);
// A background tab or prerender must not fetch the PDF or create a session.
// Focusing the tab opens it automatically, with no second "Open" click.
function autoOpen() {
  if (document.visibilityState !== 'visible' || !document.hasFocus() || document.prerendering) return;
  window.removeEventListener('focus', autoOpen);
  document.removeEventListener('visibilitychange', autoOpen);
  document.removeEventListener('prerenderingchange', autoOpen);
  void openDocument();
}
window.addEventListener('focus', autoOpen);
document.addEventListener('visibilitychange', autoOpen);
document.addEventListener('prerenderingchange', autoOpen);
autoOpen();
nativeButton?.addEventListener('click', () => {
  if (nativeUrl && !stopped) window.open(nativeUrl, '_blank', 'noopener');
});
window.addEventListener('pagehide', event => {
  if (nativeUrl && !event.persisted) setTimeout(() => URL.revokeObjectURL(nativeUrl), 60_000);
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p' && nativeUrl && !stopped) {
    event.preventDefault(); nativeButton?.click();
  }
  if (event.key === 'Escape') document.querySelector('.document-info')?.removeAttribute('open');
});
document.addEventListener('click', event => {
  const info = document.querySelector('.document-info');
  if (!info?.contains(event.target)) info?.removeAttribute('open');
});
download?.addEventListener('click', async event => {
  event.preventDefault();
  if (!session || opening || stopped || download.getAttribute('aria-disabled') === 'true') return;
  download.setAttribute('aria-disabled', 'true');
  try {
    const response = await fetch(`${base}/download`, { headers: { 'X-Document-Session': session.sessionToken }, credentials: 'omit', signal: AbortSignal.timeout(30_000) });
    if ([403, 404].includes(response.status)) { stop(); return; }
    if (!response.ok) throw new Error('Download unavailable. Try again.');
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = root.dataset.filename || 'document.pdf'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) { progress.textContent = error.message; }
  finally { if (!stopped) download.removeAttribute('aria-disabled'); }
});
async function renderDocument(pdf) {
  const first = await pdf.getPage(1);
  const natural = first.getViewport({ scale: 1 });
  const entries = []; pagesEl.replaceChildren();
  let currentPage = 1;
  const availableWidth = () => Math.max(200, innerWidth - 32);
  const zoomWidth = () => {
    if (zoom.value === 'auto') return Math.min(900, availableWidth());
    if (zoom.value === 'fit-width') return availableWidth();
    if (zoom.value === 'fit-page') return Math.min(availableWidth(), Math.max(160, innerHeight - document.querySelector('.bar').getBoundingClientRect().height - 48) * natural.width / natural.height);
    return natural.width * 96 / 72 * Number(zoom.value) / 100;
  };
  const sizePages = () => { pagesEl.style.width = `${zoomWidth()}px`; };
  sizePages();
  pageCount.textContent = ` / ${pdf.numPages}`; pageNumber.max = String(pdf.numPages);
  for (const control of [pageNumber, zoom, zoomIn, zoomOut]) control.disabled = false;
  const updatePage = number => {
    currentPage = number;
    if (document.activeElement !== pageNumber) pageNumber.value = String(number);
    previousPage.disabled = number <= 1; nextPage.disabled = number >= pdf.numPages;
  };
  const goToPage = number => {
    const safe = Math.min(pdf.numPages, Math.max(1, Number.isFinite(number) ? Math.round(number) : currentPage));
    pageNumber.value = String(safe); updatePage(safe);
    entries[safe - 1]?.frame.scrollIntoView({ block: 'start' });
  };
  const pageChange = () => goToPage(Number(pageNumber.value));
  const back = () => goToPage(currentPage - 1);
  const forward = () => goToPage(currentPage + 1);
  pageNumber.addEventListener('change', pageChange);
  previousPage.addEventListener('click', back); nextPage.addEventListener('click', forward);
  updatePage(1);
  for (let number = 1; number <= pdf.numPages; number++) {
    const frame = document.createElement('section'); frame.className = 'page'; frame.dataset.page = String(number);
    frame.style.aspectRatio = `${natural.width} / ${natural.height}`;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `Page ${number} of ${pdf.numPages}`); frame.append(canvas);
    if (watermark) {
      const layer = Object.assign(document.createElement('div'), { className: 'watermark' }); layer.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < 3; i++) layer.append(Object.assign(document.createElement('span'), { textContent: watermark }));
      frame.append(layer);
    }
    pagesEl.append(frame); entries.push({ number, frame, canvas, width: 0, rendering: false, rerender: false, ready: false, near: false, pdfPage: null });
  }
  let measureQueued = false;
  function measure() {
    measureQueued = false;
    let best = null; let bestArea = 0;
    const top = document.querySelector('.bar').getBoundingClientRect().bottom;
    for (const entry of entries) {
      if (!entry.ready) continue;
      const rect = entry.frame.getBoundingClientRect();
      const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, top));
      const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
      const area = width * height;
      // Viewport coverage handles pages taller than a phone screen.
      if (height >= Math.min(rect.height, innerHeight - top) * 0.25 && width >= Math.min(rect.width, innerWidth) * 0.5 && area > bestArea) { best = entry.number; bestArea = area; }
    }
    if (best !== null) updatePage(best);
    activity.page(best);
  }
  function scheduleMeasure() { if (!measureQueued) { measureQueued = true; requestAnimationFrame(measure); } }
  function releaseCanvas(entry) {
    if (entry.rendering) return;
    entry.ready = false; entry.width = 0; entry.frame.dataset.rendered = 'false';
    entry.canvas.width = 0; entry.canvas.height = 0;
    entry.pdfPage?.cleanup();
    scheduleMeasure();
  }
  async function render(entry) {
    const width = entry.frame.clientWidth;
    if (stopped || !width || entry.width === width) return;
    if (entry.rendering) { entry.rerender = true; return; }
    entry.rendering = true; entry.ready = false; entry.frame.dataset.rendered = 'false'; measure();
    try {
      const page = entry.number === 1 ? first : await pdf.getPage(entry.number);
      entry.pdfPage = page;
      const viewport = page.getViewport({ scale: 1 }); entry.frame.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
      const scale = Math.min(devicePixelRatio || 1, 2, Math.sqrt(8_000_000 / (width * width * viewport.height / viewport.width)));
      const sized = page.getViewport({ scale: width / viewport.width * scale });
      entry.canvas.width = Math.floor(sized.width); entry.canvas.height = Math.floor(sized.height);
      await page.render({ canvas: entry.canvas, viewport: sized }).promise;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      entry.width = width; entry.ready = true; entry.frame.dataset.rendered = 'true';
      entry.frame.querySelector('.page-error')?.remove();
      pagesEl.setAttribute('aria-busy', 'false'); progress.textContent = '';
    } catch {
      if (stopped) return;
      entry.canvas.setAttribute('aria-label', `Page ${entry.number} could not be displayed`);
      entry.frame.querySelector('.page-error')?.remove();
      const error = Object.assign(document.createElement('div'), { className: 'page-error', textContent: `Page ${entry.number} could not be displayed. ` });
      const retry = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Retry page' });
      retry.addEventListener('click', () => { error.remove(); void render(entry); });
      error.append(retry); entry.frame.append(error);
      pagesEl.setAttribute('aria-busy', 'false'); progress.textContent = '';
    } finally {
      entry.rendering = false; scheduleMeasure();
      if (stopped || !entry.near) { releaseCanvas(entry); return; }
      if (entry.rerender) { entry.rerender = false; void render(entry); }
    }
  }
  const near = new IntersectionObserver(items => {
    for (const item of items) {
      const entry = entries[Number(item.target.dataset.page) - 1]; entry.near = item.isIntersecting;
      if (entry.near) void render(entry); else releaseCanvas(entry);
    }
  }, { rootMargin: '600px 0px' });
  for (const entry of entries) near.observe(entry.frame);
  window.addEventListener('scroll', scheduleMeasure, { passive: true });
  const resize = () => {
    sizePages();
    for (const entry of entries) { const rect = entry.frame.getBoundingClientRect(); if (rect.bottom > -600 && rect.top < innerHeight + 600) void render(entry); }
    scheduleMeasure();
  };
  window.addEventListener('resize', resize);
  const changeZoom = () => {
    activity.pause(); resize();
    entries[currentPage - 1]?.frame.scrollIntoView({ block: 'start' });
  };
  const stepZoom = direction => {
    const percent = zoomWidth() / (natural.width * 96 / 72) * 100;
    const steps = [50,75,100,125,150,200,300];
    zoom.value = String(direction > 0 ? steps.find(value => value > percent + 1) ?? 300 : steps.findLast(value => value < percent - 1) ?? 50);
    changeZoom();
  };
  const bigger = () => stepZoom(1); const smaller = () => stepZoom(-1);
  zoom.addEventListener('change', changeZoom); zoomIn.addEventListener('click', bigger); zoomOut.addEventListener('click', smaller);
  window.addEventListener('focus', scheduleMeasure);
  const blur = () => { activity.pause(); void activity.flush(true); };
  const visibility = () => { if (document.hidden) { activity.pause(); void activity.flush(true); } else scheduleMeasure(); };
  const pagehide = () => { activity.pause('view_end'); void activity.flush(true); };
  window.addEventListener('blur', blur);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', pagehide);
  window.addEventListener('pageshow', scheduleMeasure);
  const online = () => void activity.flush();
  window.addEventListener('online', online);
  const ticks = setInterval(() => { measure(); activity.tick(); }, 1000);
  const heartbeats = setInterval(() => { activity.settle(); void activity.flush(); }, 15_000);
  releaseViewer = () => {
    near.disconnect(); clearInterval(ticks); clearInterval(heartbeats);
    pageNumber.removeEventListener('change', pageChange); previousPage.removeEventListener('click', back); nextPage.removeEventListener('click', forward);
    zoom.removeEventListener('change', changeZoom); zoomIn.removeEventListener('click', bigger); zoomOut.removeEventListener('click', smaller);
    window.removeEventListener('scroll', scheduleMeasure); window.removeEventListener('resize', resize);
    window.removeEventListener('focus', scheduleMeasure); window.removeEventListener('blur', blur);
    document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', pagehide);
    window.removeEventListener('pageshow', scheduleMeasure); window.removeEventListener('online', online);
    for (const entry of entries) releaseCanvas(entry);
    void pdf.loadingTask.destroy().catch(() => {});
  };
}

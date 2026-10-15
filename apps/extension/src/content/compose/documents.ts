import type { SdkComposeView } from '../tracking/compose-tracking';
import { ensureSurface } from '../shell/surface';
import { normalizeGmailId } from '@pigeonbox/tracking';

type View = SdkComposeView & { insertLinkIntoBodyAtCursor?: (text: string, url: string) => void };
const views = new Map<string, View>();
const attached = new WeakSet<object>();
const actions = new WeakMap<object, { available: () => boolean; open: () => void }>();

export function documentActionForCompose(compose: HTMLElement): (() => void) | null {
  for (const view of views.values()) {
    const body = view.getBodyElement?.();
    const action = actions.get(view);
    if (action?.available() && (view.getElement?.() === compose || (body && compose.contains(body)))) return action.open;
  }
  return null;
}

/**
 * Track links are inserted into exactly the composer that invoked the flow. No sending method is called.
 * The picker opens from "Track PDF…" in the tracking menu beside Send, not a separate toolbar icon.
 */
export function attachDocumentAction(view: View, available: () => boolean) {
  if (attached.has(view)) return;
  attached.add(view);
  const id = crypto.randomUUID();
  views.set(id, view);
  let busy = false;
  let picker: HTMLDialogElement | null = null;
  let sentUrls: string[] = [];
  view.on?.('destroy', () => { views.delete(id); picker?.remove(); });
  view.on?.('presending', event => {
    if (busy) { event?.cancel?.(); return; }
    const destinations = new Set([...view.getBodyElement?.()?.querySelectorAll('a') ?? []].map(anchor => anchor.href));
    // Recover links from the draft itself, including saved/reopened drafts.
    sentUrls = [...destinations].filter(raw => { try { return /^\/d\/[A-Za-z0-9_-]{32}$/.test(new URL(raw).pathname); } catch { return false; } }).slice(0, 20);
  });
  view.on?.('sent', event => {
    if (!event?.getThreadID || !sentUrls.length) return;
    // Gmail assigns a new conversation's ID only after send. Each link stays
    // attached to that receipt, including when email link tracking is disabled.
    void event.getThreadID().then(threadId => {
      return request({ type: 'CLOUD_COMPOSE_DOCUMENT_SENT', threadId: normalizeGmailId(threadId), urls: sentUrls });
    }).catch(() => undefined);
  });
  const open = () => {
    if (!available()) return;
    if (picker?.isConnected) { picker.focus(); return; }
    ensureSurface();
    picker = document.createElement('dialog');
    const dialog = picker;
    picker.className = 'gi-document-picker';
    picker.setAttribute('aria-label', 'Track PDF');
    picker.setAttribute('data-gi-ui', 'document-picker');
    const heading = Object.assign(document.createElement('h2'), { textContent: 'Track a PDF' });
    const description = Object.assign(document.createElement('p'), { textContent: 'Choose a PDF to upload privately to PigeonBox Cloud and add as a link in this email. See when the PDF is opened or downloaded beside your email’s tracking status.' });
    const hint = Object.assign(document.createElement('p'), { className: 'gi-document-hint', textContent: 'Up to 20 MB. Anyone with the link can view and download it. PDFs attached with Gmail’s paperclip do not report opens.' });
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'application/pdf,.pdf'; input.setAttribute('aria-label', 'Choose PDF to track');
    const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const close = Object.assign(document.createElement('button'), { type: 'button', className: 'gi-btn gi-btn-ghost', textContent: 'Cancel' });
    const options = Object.assign(document.createElement('button'), { type: 'button', className: 'gi-btn gi-btn-ghost', textContent: 'More options' });
    options.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'FOCUS_SIDEPANEL', mode: 'cloud', section: 'documents', composeId: id });
      dialog.close(); dialog.remove();
    });
    close.addEventListener('click', () => { dialog.close(); dialog.remove(); view.getBodyElement?.()?.focus(); });
    picker.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    picker.addEventListener('close', () => { if (!busy) dialog.remove(); });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file || busy) return;
      if (!file.size || file.size > 20_000_000) { status.textContent = 'Choose a PDF up to 20 MB.'; input.value = ''; return; }
      busy = true; input.disabled = true; close.disabled = true; options.disabled = true; status.textContent = 'Uploading PDF…';
      void (async () => {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') throw new Error('Choose a valid PDF file.');
          if (!views.has(id)) return;
          const result = await request({ type: 'CLOUD_COMPOSE_DOCUMENT', filename: file.name, bytes: encode(bytes) });
          if (!result.ok || !result.link) throw new Error(result.reason || 'PDF upload failed. Try again.');
          const inserted = insertDocumentLink({ composeId: id, url: result.link.url, title: file.name });
          if (!inserted.ok) throw new Error(inserted.reason);
          status.textContent = 'Tracked PDF added to this email. Review it before sending.';
          input.hidden = true; close.textContent = 'Done';
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : 'PDF upload failed. Try again.';
          input.value = '';
        } finally { busy = false; input.disabled = false; close.disabled = false; options.disabled = false; }
      })();
    });
    picker.append(heading, description, input, hint, status, close, options);
    document.body.append(picker); picker.showModal();
  };
  actions.set(view, { available, open });
}

function encode(bytes: Uint8Array): string {
  let raw = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) raw += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(raw);
}
function request(message: Record<string, unknown>): Promise<{ ok?: boolean; reason?: string; link?: { id: string; url: string } }> {
  return new Promise(resolve => chrome.runtime.sendMessage(message, response => {
    resolve(chrome.runtime.lastError ? { ok: false, reason: 'PigeonBox disconnected. Reload Gmail and try again.' } : response ?? { ok: false });
  }));
}

export function insertDocumentLink(message: { composeId?: unknown; url?: unknown; title?: unknown }): {
  ok: boolean;
  reason?: string;
} {
  const view = typeof message.composeId === 'string' ? views.get(message.composeId) : undefined;
  if (!view || typeof message.url !== 'string')
    return { ok: false, reason: 'The selected composer is closed. Choose a composer and try again.' };
  try {
    const url = new URL(message.url);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
      return { ok: false, reason: 'This document link is invalid.' };
    if (url.username || url.password || url.search || url.hash || !/^\/d\/[A-Za-z0-9_-]{16,200}$/.test(url.pathname))
      return { ok: false, reason: 'This document link is invalid.' };
    const title = typeof message.title === 'string' ? message.title.slice(0, 300) : 'Document';
    if (view.insertLinkIntoBodyAtCursor) view.insertLinkIntoBodyAtCursor(title, url.href);
    else {
      const body = view.getBodyElement?.();
      if (!body?.isConnected) return { ok: false, reason: 'Open the selected composer and try again.' };
      const anchor = document.createElement('a');
      anchor.textContent = title;
      anchor.href = url.href;
      body.append(document.createElement('br'), anchor);
      body.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'Could not insert the link into this composer.' };
  }
}

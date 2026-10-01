import { trackProductEvent } from '../ui/analytics';
import { useCallback, useEffect, useState } from 'react';
import type { DocumentSummary, RouteResponse } from '@pigeonbox/api-contract';
import { callCloud } from './cloud-api';
import { openCloud } from '../ui/cloud-features';
import { relative } from './WaitingView';

function encode(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
}
export function DocumentsView() {
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [selected, setSelected] = useState<DocumentSummary | null>(null);
  const [analytics, setAnalytics] = useState<RouteResponse<'documentAnalytics'> | null>(null);
  const [recipient, setRecipient] = useState('');
  const [expiry, setExpiry] = useState('');
  const [download, setDownload] = useState(false);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const result = await callCloud('documents');
    if (result.ok) setDocuments(result.data.documents);
    else setError(result.reason);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function upload(file: File | undefined) {
    if (!file) return;
    setError('');
    setNotice('');
    setLink('');
    if (file.size > 20_000_000 || !file.size) {
      setError('Choose a PDF up to 20 MB.');
      return;
    }
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') throw new Error('Choose a supported PDF file.');
      const created = await callCloud('documentCreate', {
        title: file.name.replace(/\.pdf$/i, ''),
        filename: file.name,
      });
      if (!created.ok) throw new Error(created.reason);
      const result = await new Promise<{ ok: boolean; data?: { document: DocumentSummary }; reason?: string }>(
        (resolve) =>
          chrome.runtime.sendMessage(
            { type: 'CLOUD_DOCUMENT_UPLOAD', id: created.data.document.id, bytes: encode(bytes) },
            (response) => resolve(chrome.runtime.lastError ? { ok: false } : (response ?? { ok: false })),
          ),
      );
      if (!result.ok || !result.data) throw new Error(result.reason || 'Upload did not complete. Try again.');
      trackProductEvent('tracked_document_created', { surface: 'sidepanel', mode: 'cloud' });
      setSelected(result.data.document);
      setNotice('Uploaded privately to Cloud. Create a link to share it.');
      void load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Upload did not complete. Try again.');
    } finally {
      setBusy(false);
    }
  }
  async function createLink() {
    if (!selected) return;
    setBusy(true);
    setError('');
    setNotice('');
    setLink('');
    if (expiry && !Number.isFinite(Date.parse(expiry))) {
      setBusy(false);
      setError('Choose a valid expiry date and time.');
      return;
    }
    const result = await callCloud('documentLinkCreate', {
      documentId: selected.id,
      ...(recipient.trim() ? { recipientEmail: recipient.trim() } : {}),
      ...(expiry ? { expiresAt: new Date(expiry).toISOString() } : {}),
      allowDownload: download,
      watermark: true,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setLink(result.data.link.url);
    setNotice('Link ready. Insert it into your selected Gmail composer, then review before sending.');
  }
  async function insert() {
    setBusy(true);
    const result = await new Promise<{ ok?: boolean; reason?: string }>((resolve) =>
      chrome.runtime.sendMessage(
        { type: 'INSERT_DOCUMENT_LINK', url: link, title: selected?.title ?? 'Document' },
        (response) => resolve(response ?? {}),
      ),
    );
    setBusy(false);
    if (result.ok) setNotice('Inserted into Gmail. Nothing was sent.');
    else setError(result.reason || 'Choose “Track with PigeonBox” in the Gmail composer first, then try again.');
  }
  async function inspect(document: DocumentSummary) {
    setError('');
    setAnalytics(null);
    setSelected(document);
    setLink('');
    const result = await callCloud('documentAnalytics', { documentId: document.id });
    if (result.ok) setAnalytics(result.data);
    else setError(result.reason);
  }
  return (
    <section className="gi-cloud-reader">
      <h2>Tracked documents</h2>
      <p className="gi-muted">
        Upload a PDF privately to Cloud. Recipient links can expire and restrict downloads. Nothing sends automatically.
      </p>
      <label className="gi-btn gi-btn-ghost">
        {busy ? 'Working…' : 'Upload PDF'}
        <input
          className="gi-file-input"
          aria-label="Upload PDF"
          type="file"
          accept="application/pdf,.pdf"
          disabled={busy}
          onChange={(event) => {
            void upload(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      </label>
      {notice ? (
        <p className="gi-note" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="gi-warn" role="alert">
          {error}
        </p>
      ) : null}
      {documents?.map((document) => (
        <button
          className="gi-automatic-row"
          type="button"
          key={document.id}
          disabled={busy || document.status !== 'ready'}
          onClick={() => void inspect(document)}
        >
          <strong>{document.title}</strong>
          <span>
            {document.status === 'ready' ? `${document.views} observed views` : document.status}
            {document.lastViewedAt ? ` · last ${relative(document.lastViewedAt)}` : ''}
          </span>
        </button>
      ))}
      {documents && !documents.length ? (
        <p className="gi-muted">No tracked documents yet.</p>
      ) : !documents ? (
        <button className="gi-text-btn" type="button" onClick={() => void load()}>
          Refresh documents
        </button>
      ) : null}
      {selected ? (
        <section className="gi-cloud-block">
          <h3>{selected.title}</h3>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void createLink();
            }}
          >
            <label className="gi-cloud-field">
              Recipient (optional)
              <input
                className="gi-field"
                type="email"
                value={recipient}
                onChange={(event) => setRecipient(event.target.value)}
                maxLength={320}
              />
            </label>
            <label className="gi-cloud-field">
              Expires (optional)
              <input
                className="gi-field"
                type="datetime-local"
                value={expiry}
                onChange={(event) => setExpiry(event.target.value)}
              />
            </label>
            <label className="gi-consent">
              <input type="checkbox" checked={download} onChange={(event) => setDownload(event.target.checked)} />
              Allow download
            </label>
            <button className="gi-btn" type="submit" disabled={busy}>
              Create tracked link
            </button>
          </form>
          {link ? (
            <div className="gi-cloud-actions">
              <button className="gi-btn" type="button" disabled={busy} onClick={() => void insert()}>
                Insert into Gmail
              </button>
              <button
                className="gi-btn gi-btn-ghost"
                type="button"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(link)
                    .then(() => setNotice('Link copied. Review your email before sending.'))
                    .catch(() => setError('Clipboard permission was denied. Insert into Gmail instead.'))
                }
              >
                Copy link
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
      {analytics ? (
        <section className="gi-cloud-block">
          <h3>Observed activity</h3>
          {analytics.links.map((item) => (
            <div className="gi-shadow-decision" key={item.link.id}>
              <strong>
                {item.link.recipientEmail ? 'Recipient-specific link' : 'Shared link'} · {item.views} views ·{' '}
                {item.downloads} downloads
              </strong>
              <p className="gi-muted">
                {item.lastViewedAt ? `Last viewed ${relative(item.lastViewedAt)}` : 'Not viewed'} ·{' '}
                {item.precision.replace(/_/g, ' ')}
              </p>
              {item.visibleSeconds !== null ? <p>{item.visibleSeconds} seconds visible in the viewer</p> : null}
              {item.pages ? (
                <ul>
                  {item.pages.map((page) => (
                    <li key={page.page}>
                      Page {page.page} · {page.views} observed views · {page.visibleSeconds} seconds visible
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="gi-muted">Page visibility was not observed.</p>
              )}
            </div>
          ))}
          {analytics.notes.map((note, index) => (
            <p className="gi-muted" key={index}>
              {note}
            </p>
          ))}
        </section>
      ) : null}
      <button className="gi-text-btn" type="button" onClick={() => openCloud('documents')}>
        Manage documents ↗
      </button>
    </section>
  );
}

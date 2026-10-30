import { upload } from '../../lib/session.js';
import { ago, button, checkbox, clear, confirmDialog, copyText, day, empty, emptyState, eyebrow, field, h, input, note, pill, plural, secretDialog, surface, table, toast } from '../ui.js';

const PRECISION = {
  pages_observed: ['Pages seen', 'good', 'The PigeonBox viewer rendered these pages and saw them on screen.'],
  session_only: ['Opened', 'info', 'The viewer opened, but page visibility was not reported.'],
  download_only: ['File fetched', 'neutral', 'Only the file was fetched; nothing is known about reading.'],
  none: ['Not opened', 'neutral', 'Nobody has opened this link.'],
};
const MAX_MB = 20;

function stats(row) {
  const [label, tone, detail] = PRECISION[row.precision];
  return h(
    'div',
    { class: 'link-stats' },
    h('div', { class: 'row' }, pill(label, tone), row.views ? h('span', { class: 'muted' }, `${plural(row.views, 'view')} · first ${ago(row.firstViewedAt)} · last ${ago(row.lastViewedAt)}`) : null),
    h('p', { class: 'hint' }, detail),
    row.visibleSeconds !== null ? h('p', {}, `On screen for ${Math.round(row.visibleSeconds / 60) ? `${Math.round(row.visibleSeconds / 60)} min` : `${row.visibleSeconds} s`}`) : null,
    row.downloads ? h('p', {}, plural(row.downloads, 'download')) : null,
    row.pages
      ? h(
          'div',
          { class: 'pagebars', attrs: { role: 'list', 'aria-label': 'Time per page' } },
          row.pages.map((page) => {
            const max = Math.max(...row.pages.map((item) => item.visibleSeconds), 1);
            const bar = h('span', { class: 'pagebar-fill' });
            bar.style.width = `${Math.max(4, (page.visibleSeconds / max) * 100)}%`;
            return h('div', { class: 'pagebar', attrs: { role: 'listitem' } }, h('span', { class: 'pagebar-label' }, `p${page.page}`), h('span', { class: 'pagebar-track' }, bar), h('span', { class: 'muted' }, `${page.visibleSeconds}s`));
          }),
        )
      : null,
  );
}

async function detail(document, { api, back }) {
  const holder = h('div', { class: 'stack' });
  const draw = async () => {
    const data = await api('/v1/documents/analytics', { method: 'POST', body: { documentId: document.id } });
    const recipient = input({ type: 'email', placeholder: 'name@example.com (optional)', attrs: { 'aria-label': 'Recipient email' } });
    const expires = input({ type: 'date', attrs: { 'aria-label': 'Expires on' } });
    const allowDownload = checkbox('Allow download', false);
    const watermark = checkbox('Watermark pages with the recipient', true);
    clear(
      holder,
      h('button', { type: 'button', class: 'back', on: { click: () => back() } }, '← Documents'),
      button('Refresh activity', draw, { small: true, variant: 'ghost' }),
      surface(
        'card',
        {},
        h('header', { class: 'detail-head' }, h('div', {}, eyebrow(`${data.document.filename} · ${data.document.pageCount === null ? 'page count unknown' : plural(data.document.pageCount, 'page')} · uploaded ${day(data.document.createdAt)}`), h('h2', {}, data.document.title)), pill(data.document.status, data.document.status === 'ready' ? 'good' : 'neutral')),
        data.notes.map((text) => h('p', { class: 'hint' }, text)),
      ),
      data.document.status === 'ready' ? surface(
        'slip',
        { title: 'New link', className: 'composer' },
        h('p', {}, 'Make one link per recipient to keep activity separate. Anyone holding a link can open it; the recipient label does not verify identity.'),
        h('div', { class: 'grid-2' }, field('Recipient', recipient), field('Expires', expires)),
        allowDownload,
        watermark,
        h(
          'div',
          { class: 'row' },
          button('Create link', async () => {
            const { link } = await api('/v1/documents/links/create', {
              method: 'POST',
              body: {
                documentId: document.id,
                ...(recipient.value.trim() ? { recipientEmail: recipient.value.trim() } : {}),
                ...(expires.value ? { expiresAt: new Date(`${expires.value}T23:59:59`).toISOString() } : {}),
                allowDownload: allowDownload.querySelector('input').checked,
                watermark: watermark.querySelector('input').checked,
              },
            });
            await draw();
            await secretDialog('Link ready', link.url, [link.recipientEmail ? `For ${link.recipientEmail}. Send it however you like; each open is attributed to this link.` : 'Anyone with this link can open the document.']);
          }),
        ),
      ) : note(data.document.status === 'deleted' ? 'File removal is pending. Links are disabled. Retry deleting to finish removal.' : 'Upload this PDF before creating a link. If an upload failed, delete this entry and try again.', 'info'),
      surface(
        'ledger',
        { title: 'Links' },
        data.links.length
          ? h(
              'ul',
              { class: 'list' },
              data.links.map((row) =>
                h(
                  'li',
                  { class: row.link.revokedAt ? 'revoked' : null },
                  h('div', { class: 'list-main' }, h('strong', {}, row.link.recipientEmail ?? 'Anyone with the link'), h('span', { class: 'muted' }, [`Created ${ago(row.link.createdAt)}`, row.link.expiresAt ? `expires ${day(row.link.expiresAt)}` : null, row.link.allowDownload ? 'download on' : 'view only', row.link.revokedAt ? `revoked ${ago(row.link.revokedAt)}` : null].filter(Boolean).join(' · '))),
                  stats(row),
                  row.link.revokedAt || data.document.status !== 'ready' || (row.link.expiresAt && Date.parse(row.link.expiresAt) <= Date.now())
                    ? null
                    : h(
                        'div',
                        { class: 'row' },
                        button('Copy link', () => copyText(row.link.url), { small: true, variant: 'ghost' }),
                        button('Preview', async () => {
                          const tab = window.open('about:blank', '_blank');
                          if (tab) tab.opener = null;
                          try {
                            const { url } = await api('/v1/control/documents/preview', { method: 'POST', body: { linkId: row.link.id } });
                            if (tab) tab.location.replace(url);
                            else await secretDialog('Sender preview', url, ['Open this preview within five minutes. It is excluded from recipient activity.']);
                          } catch (error) { tab?.close(); throw error; }
                        }, { small: true, variant: 'ghost' }),
                        button('Revoke', async () => {
                          if (!(await confirmDialog({ title: 'Revoke this link?', body: ['It stops working immediately for everyone who has it.'], confirm: 'Revoke', danger: true }))) return;
                          await api('/v1/documents/links/revoke', { method: 'POST', body: { linkId: row.link.id } });
                          toast('Revoked.', 'success');
                          await draw();
                        }, { small: true, variant: 'danger-ghost' }),
                      ),
                ),
              ),
            )
          : empty('No links yet.'),
      ),
      h(
        'div',
        { class: 'row' },
        button('Delete document…', async () => {
          if (!(await confirmDialog({ title: `Delete “${data.document.title}”?`, body: ['The file and every link are deleted. Links stop working immediately.'], confirm: 'Delete', danger: true }))) return;
          await api('/v1/control/documents/delete', { method: 'POST', body: { id: document.id } });
          toast('Deleted.', 'success');
          back();
        }, { variant: 'danger-ghost' }),
      ),
    );
  };
  await draw();
  return holder;
}

export async function render({ api }) {
  const root = h('div');
  const draw = async () => {
    const { documents } = await api('/v1/documents');
    const file = input({ type: 'file', accept: 'application/pdf,.pdf', attrs: { 'aria-label': 'PDF file' } });
    const title = input({ maxLength: 300, placeholder: 'Title shown to viewers' });
    file.addEventListener('change', () => {
      if (!title.value && file.files[0]) title.value = file.files[0].name.replace(/\.pdf$/i, '');
    });
    const open = async (document) => clear(root, await detail(document, { api, back: draw }));
    clear(
      root,
      h(
        'div',
        { class: 'stack' },
        surface(
          'slip',
          { title: 'Share a PDF', className: 'composer' },
          h('p', {}, 'Share a PDF through PigeonBox’s viewer and see activity for each link: opens, pages on screen, visible time, and downloads.'),
          h('div', { class: 'grid-2' }, field('PDF', file, `Up to ${MAX_MB} MB and 500 pages. Unencrypted PDFs only.`), field('Title', title)),
          h(
            'div',
            { class: 'row' },
            button('Upload', async () => {
              const pdf = file.files[0];
              if (!pdf) throw new Error('Choose a PDF.');
              if (pdf.type && pdf.type !== 'application/pdf') throw new Error('Only PDF files can be shared.');
              if (pdf.size > MAX_MB * 1_000_000) throw new Error(`That file is larger than ${MAX_MB} MB.`);
              const created = await api('/v1/control/documents/create', { method: 'POST', body: { title: title.value.trim() || pdf.name, filename: pdf.name.slice(0, 255) } });
              try { await upload(created.uploadPath, new File([pdf], pdf.name, { type: 'application/pdf' })); }
              catch (error) {
                // Remove an abandoned upload when possible; otherwise it stays
                // visible as an incomplete document the owner can remove.
                try { await api('/v1/control/documents/delete', { method: 'POST', body: { id: created.document.id } }); } catch { /* retry from Documents */ }
                throw error;
              }
              toast('Uploaded. Create a link to share it.', 'success');
              await open(created.document);
            }, { busy: 'Uploading…' }),
          ),
        ),
        documents.length
          ? surface(
              'ledger',
              { title: 'Documents' },
              table(
                [
                  { label: 'Title', render: (row) => h('button', { type: 'button', class: 'link-button', on: { click: () => open(row) } }, row.title) },
                  { label: 'Links', numeric: true, render: (row) => row.links },
                  { label: 'Views', numeric: true, render: (row) => row.views },
                  { label: 'Last viewed', render: (row) => (row.lastViewedAt ? ago(row.lastViewedAt) : '—') },
                  { label: 'Status', render: (row) => pill(row.status, row.status === 'ready' ? 'good' : row.status === 'failed' ? 'bad' : 'neutral') },
                ],
                documents,
              ),
            )
          : emptyState({ state: 'parcel', title: 'No documents yet', text: 'Upload a PDF above, then make one link per person to see who opened what.' }),
        note('Use Preview to open your own links without adding recipient activity. Recipient labels identify links, not verified people. Known scanners, screenshots and reading outside this viewer are excluded.', 'info'),
      ),
    );
  };
  await draw();
  return root;
}

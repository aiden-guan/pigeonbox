import { ago, button, clear, confirmDialog, empty, emptyState, h, humanize, key, note, pill, surface, tabs, textarea, when } from '../ui.js';
import { accountEmails, gmailLink, tierStamp } from '../shared.js';

const PLACEHOLDER = /\[(?:[A-Z][A-Z ]+ NEEDED|CONFIRM [A-Z ]+|DATE|TIME|LINK|NAME|ATTACHMENT|AMOUNT)\]/g;

function preview(approval, onEdit) {
  const p = approval.preview;
  const parts = [];
  if (p.to?.length) parts.push(h('p', { class: 'kv' }, h('span', {}, 'To'), p.to.join(', ')));
  if (p.cc?.length) parts.push(h('p', { class: 'kv' }, h('span', {}, 'Cc'), p.cc.join(', ')));
  if (p.subject) parts.push(h('p', { class: 'kv' }, h('span', {}, 'Subject'), p.subject));
  if (p.event) {
    parts.push(h('p', { class: 'kv' }, h('span', {}, 'Event'), p.event.title));
    parts.push(h('p', { class: 'kv' }, h('span', {}, 'When'), `${when(p.event.start)} – ${when(p.event.end, { timeStyle: 'short' })}`));
    if (p.event.attendees.length) parts.push(h('p', { class: 'kv' }, h('span', {}, 'Invites'), p.event.attendees.join(', ')));
  }
  if (p.change) parts.push(h('p', { class: 'kv' }, h('span', {}, 'Change'), p.change));
  if (p.count !== undefined) parts.push(h('p', { class: 'kv' }, h('span', {}, 'Count'), String(p.count)));
  if (p.body !== undefined) {
    const editable = approval.status === 'pending' && approval.kind === 'send_email';
    const body = textarea({ value: p.body, rows: Math.min(14, Math.max(5, p.body.split('\n').length + 1)), readOnly: !editable, attrs: { 'aria-label': 'Message body' } });
    if (editable) body.addEventListener('input', () => onEdit(body.value));
    parts.push(body);
  }
  return parts.length ? h('div', { class: 'preview' }, parts) : null;
}

function approvalCard(approval, emails, api, refresh) {
  let edited = null;
  const warning = h('div');
  const approve = button('Approve', async () => {
    const body = edited ?? approval.preview.body;
    const open = (body ?? '').match(PLACEHOLDER) ?? [];
    if (open.length) throw new Error(`Fill in ${[...new Set(open)].join(', ')} before approving.`);
    const sends = approval.kind === 'send_email';
    if (sends) {
      const ok = await confirmDialog({
        title: approval.preview.count && approval.preview.count > 1 ? `Send ${approval.preview.count} emails?` : 'Send this email?',
        body: approval.preview.count && approval.preview.count > 1 ? 'Each person receives their own message within the sending window. Replies and unsubscribes stop it for that person.' : `It goes to ${approval.preview.to?.join(', ') ?? 'the recipients shown'} exactly as shown.`,
        confirm: 'Send',
        label: 'Ready to send',
      });
      if (!ok) return;
    }
    await api('/v1/approvals/decide', { method: 'POST', body: { id: approval.id, decision: 'approve', idempotencyKey: key(), ...(edited !== null && edited !== approval.preview.body ? { edits: { body: edited } } : {}) } });
    await refresh(sends ? 'Approved. Sending now.' : 'Approved.');
  }, { busy: 'Approving…' });
  const reject = button('Reject', async () => {
    await api('/v1/approvals/decide', { method: 'POST', body: { id: approval.id, decision: 'reject', idempotencyKey: key() } });
    await refresh('Rejected. Nothing was done.');
  }, { variant: 'ghost', busy: 'Rejecting…' });

  const updateWarning = () => {
    const open = [...new Set((edited ?? approval.preview.body ?? '').match(PLACEHOLDER) ?? [])];
    clear(warning, open.length ? note(`Fill in ${open.join(', ')} before approving.`, 'warn') : null);
  };
  updateWarning();

  const decided = approval.status !== 'pending';
  return surface(
    decided ? 'card' : 'parcel',
    {
      tag: 'article',
      className: 'approval',
      eyebrow: `${approval.responsible.name} · ${ago(approval.createdAt)}${approval.expiresAt && !decided ? ` · expires ${ago(approval.expiresAt)}` : ''}`,
      title: approval.title,
      actions: tierStamp(approval.tier),
    },
    h('p', {}, approval.why),
    preview(approval, (value) => {
      edited = value;
      updateWarning();
    }),
    approval.sources.length
      ? h('div', { class: 'sources' }, h('span', { class: 'muted' }, 'Based on '), approval.sources.map((source) => (source.gmailThreadId ? gmailLink(source.title, emails.get(source.accountId), source.gmailThreadId) : h('span', { class: 'source' }, source.title))))
      : null,
    warning,
    decided
      ? h('div', { class: 'split' }, pill(humanize(approval.status), approval.status === 'approved' || approval.status === 'executed' ? 'good' : approval.status === 'rejected' ? 'neutral' : 'info'), h('p', { class: 'muted' }, `${approval.decidedAt ? `Decided ${ago(approval.decidedAt)}` : ''}${approval.result ? ` · ${approval.result.message}` : ''}`))
      : h('div', { class: 'row tight' }, approve, reject),
  );
}

export async function render({ api, refreshCounts, toast }) {
  const emails = await accountEmails();
  let justDecided = false;
  const list = (status) => async () => {
    const holder = h('div', { class: 'stack' });
    const draw = async () => {
      const { approvals } = await api('/v1/approvals/list', { method: 'POST', body: { status, limit: 50 } });
      const refresh = async (message) => {
        toast(message, 'success');
        refreshCounts();
        justDecided = true;
        await draw();
      };
      clear(
        holder,
        approvals.length
          ? approvals.map((approval) => approvalCard(approval, emails, api, refresh))
          : status === 'pending'
            ? emptyState({
                state: justDecided ? 'stars' : 'tea',
                title: justDecided ? 'All decided. Nothing else is waiting.' : 'Nothing is waiting for you.',
                text: 'Sends, invitations and anything an automation is not allowed to do on its own will appear here first.',
              })
            : empty('No decisions yet.'),
      );
    };
    await draw();
    return holder;
  };
  return [
    tabs([
      ['pending', 'Waiting', list('pending')],
      ['decided', 'Decided', list('decided')],
    ]),
    h(
      'div',
      { class: 'tier-legend', attrs: { role: 'note', 'aria-label': 'Risk tiers' } },
      h('span', {}, pill('Tier 0–1', 'neutral'), 'Read-only or undoable changes'),
      h('span', {}, pill('Tier 2', 'info'), 'Visible changes such as Gmail drafts or calendar holds'),
      h('span', {}, pill('Tier 3', 'warn'), 'Sending and invitations, always approved one by one'),
    ),
  ];
}

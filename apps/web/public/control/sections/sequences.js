import { ago, button, checkbox, clear, confirmDialog, emptyState, facts, field, h, input, note, pill, select, surface, table, tabs, textarea, toast } from '../ui.js';
import { accounts } from '../shared.js';

const STATUS = { draft: ['Draft', 'neutral'], active: ['Running', 'good'], paused: ['Paused', 'neutral'], stopped: ['Stopped', 'bad'], completed: ['Completed', 'info'] };

/** "email,first_name,company" with a header row. Returns recipients and rejected lines. */
function parseRecipients(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { recipients: [], rejected: 0 };
  const split = (line) => line.split(/[,\t;]/).map((cell) => cell.trim().replace(/^"|"$/g, ''));
  const header = split(lines[0]).map((cell) => cell.toLowerCase().replace(/\s+/g, '_'));
  const hasHeader = !header.some((cell) => cell.includes('@'));
  const columns = hasHeader ? header : ['email'];
  const emailAt = Math.max(0, columns.indexOf('email'));
  const recipients = [];
  let rejected = 0;
  for (const line of hasHeader ? lines.slice(1) : lines) {
    const cells = split(line);
    const email = cells[emailAt] ?? '';
    if (!email.includes('@')) {
      rejected += 1;
      continue;
    }
    const fields = {};
    columns.forEach((column, index) => {
      if (index !== emailAt && cells[index] && /^[a-z_][a-z0-9_]{0,39}$/.test(column)) fields[column] = cells[index].slice(0, 500);
    });
    recipients.push({ email, fields });
  }
  return { recipients: recipients.slice(0, 500), rejected };
}

function stepEditor(step = { delayBusinessDays: 0, subject: '', body: '' }, index) {
  const delay = input({ type: 'number', min: 0, max: 60, value: step.delayBusinessDays });
  const subject = input({ value: step.subject, maxLength: 500 });
  const body = textarea({ value: step.body, rows: 6, maxLength: 10_000 });
  const el = h(
    'fieldset',
    { class: 'step' },
    h('legend', {}, `Step ${index + 1}`),
    index ? field('Wait (business days after the previous step)', delay) : null,
    field('Subject', subject),
    field('Message', body, 'Use {first_name}, {company} or any column from your list. A missing value is never guessed: that person is held back.'),
  );
  return { el, value: () => ({ delayBusinessDays: index ? Number(delay.value) || 0 : 0, subject: subject.value.trim(), body: body.value.trim(), aiPersonalize: false }) };
}

async function editor(sequence, { api, dailyLimit, back }) {
  const { accounts: list } = await accounts();
  const senders = list.filter((account) => account.status === 'active');
  if (!senders.length) return note('Connect a Google account first.', 'warn');
  const name = input({ value: sequence?.name ?? '', maxLength: 120 });
  const account = select(senders.map((item) => [item.id, `${item.email}${item.features.includes('send') ? '' : ' (needs Send permission)'}`]), sequence?.accountId ?? senders[0].id);
  const limit = input({ type: 'number', min: 1, max: dailyLimit, value: sequence?.dailyLimit ?? Math.min(25, dailyLimit) });
  const start = input({ type: 'time', value: sequence?.window.start ?? '09:00' });
  const end = input({ type: 'time', value: sequence?.window.end ?? '17:00' });
  const stopOnReply = checkbox('Stop for a person when they reply', sequence?.stopOnReply ?? true);
  const trackOpens = checkbox('Track opens', sequence?.trackOpens ?? false, {}, 'Opens are signals, not proof of reading.');
  const stepsEl = h('div', { class: 'stack' });
  const steps = [];
  const addStep = (step) => {
    if (steps.length >= 5) return toast('Up to five steps.', 'error');
    const editorStep = stepEditor(step, steps.length);
    steps.push(editorStep);
    stepsEl.append(editorStep.el);
  };
  for (const step of sequence?.steps ?? [undefined]) addStep(step);

  return h(
    'div',
    { class: 'stack' },
    h('button', { type: 'button', class: 'back', on: { click: () => back() } }, '← Sequences'),
    surface(
      'card',
      { eyebrow: sequence ? 'Edit sequence' : 'New sequence', title: sequence ? sequence.name : 'A new sequence' },
      field('Name', name),
      field('Send from', account),
      h('div', { class: 'grid-3' }, field(`Emails per day (up to ${dailyLimit})`, limit), field('Window starts', start), field('Window ends', end)),
      stopOnReply,
      trackOpens,
      stepsEl,
      h(
        'div',
        { class: 'row' },
        button('Add step', () => addStep(), { variant: 'ghost' }),
        button('Save', async () => {
          const body = {
            ...(sequence ? { id: sequence.id } : {}),
            name: name.value.trim(),
            accountId: account.value,
            dailyLimit: Math.min(dailyLimit, Math.max(1, Number(limit.value) || 1)),
            window: { start: start.value || '09:00', end: end.value || '17:00' },
            stopOnReply: stopOnReply.querySelector('input').checked,
            trackOpens: trackOpens.querySelector('input').checked,
            steps: steps.map((step) => step.value()),
          };
          if (!body.name) throw new Error('Give the sequence a name.');
          if (body.steps.some((step) => !step.subject || !step.body)) throw new Error('Every step needs a subject and a message.');
          await api('/v1/control/sequences/save', { method: 'POST', body });
          toast('Saved.', 'success');
          back();
        }),
      ),
    ),
  );
}

function sequenceCard(sequence, { api, redraw, edit }) {
  const list = textarea({ rows: 5, placeholder: 'email,first_name,company\nkim@example.com,Kim,Acme' });
  const enroll = button('Add people', async () => {
    const { recipients, rejected } = parseRecipients(list.value);
    if (!recipients.length) throw new Error('Paste at least one email address.');
    const result = await api('/v1/control/sequences/enroll', { method: 'POST', body: { sequenceId: sequence.id, recipients } });
    toast(`${result.added} added · ${result.suppressed} on your suppression list · ${result.invalid + rejected} invalid.`, 'success');
    await redraw();
  }, { variant: 'ghost' });
  const setStatus = (status, label, confirmText) =>
    button(label, async () => {
      if (confirmText && !(await confirmDialog({ title: `${label}?`, body: [confirmText], confirm: label, danger: status === 'stopped' }))) return;
      const result = await api('/v1/control/sequences/status', { method: 'POST', body: { sequenceId: sequence.id, status } });
      if (status === 'active') {
        toast(result.approvalId ? `${result.count} emails are waiting for your approval${result.blocked ? `; ${result.blocked} held back for missing fields` : ''}.` : 'Running. Nothing is due right now.', 'success');
        if (result.approvalId) location.hash = '#approvals';
      }
      await redraw();
    }, { variant: status === 'active' ? 'primary' : status === 'stopped' ? 'danger-ghost' : 'ghost' });

  const counts = sequence.counts;
  return surface(
    'card',
    { tag: 'article', eyebrow: `${sequence.steps.length} steps · up to ${sequence.dailyLimit}/day · ${sequence.window.start}–${sequence.window.end}`, title: sequence.name, actions: pill(...(STATUS[sequence.status] ?? [sequence.status, 'neutral'])) },
    facts([
      ['Enrolled', counts.enrolled],
      ['Active', counts.active],
      ['Replied', counts.replied],
      ['Sent', counts.sent],
      ['Awaiting approval', counts.pendingApproval],
    ].map(([label, value]) => [label, String(value)])),
    sequence.status !== 'stopped' && sequence.status !== 'completed'
      ? h('details', { class: 'disclosure' }, h('summary', {}, 'Add people'), list, h('p', { class: 'hint' }, 'Suppressed and invalid addresses are skipped. Every batch still needs your approval before anything is sent.'), h('div', { class: 'row' }, enroll))
      : null,
    h(
      'div',
      { class: 'row' },
      sequence.status === 'active' ? setStatus('paused', 'Pause') : sequence.status !== 'stopped' && sequence.status !== 'completed' ? setStatus('active', 'Start') : null,
      sequence.status !== 'stopped' && sequence.status !== 'completed' ? setStatus('stopped', 'Stop', 'No more emails go out from this sequence, including approved ones not yet sent.') : null,
      sequence.status === 'draft' || sequence.status === 'paused' ? button('Edit', () => edit(sequence), { variant: 'ghost' }) : null,
    ),
  );
}

export async function render({ api }) {
  const root = h('div');
  const draw = async () => {
    const { sequences, dailyLimit } = await api('/v1/control/sequences');
    const show = (sequence) => editor(sequence, { api, dailyLimit, back: draw }).then((content) => clear(root, content));
    clear(
      root,
      h(
        'div',
        { class: 'stack' },
        tabs([
          [
            'sequences',
            'Sequences',
            async () =>
              h(
                'div',
                { class: 'stack' },
                h('div', { class: 'row tight' }, button('New sequence', () => show(null))),
                sequences.length
                  ? sequences.map((sequence) => sequenceCard(sequence, { api, redraw: draw, edit: show }))
                  : emptyState({ state: 'plane', title: 'No sequences yet', text: 'Write a few steps, add the people you would write to anyway, and approve each batch before it goes out.' }),
              ),
          ],
          [
            'suppressions',
            'Do not contact',
            async () => {
              const holder = h('div', { class: 'stack' });
              const drawSuppressions = async () => {
                const { suppressions } = await api('/v1/control/suppressions');
                const email = input({ type: 'email', placeholder: 'name@example.com', attrs: { 'aria-label': 'Email to suppress' } });
                clear(
                  holder,
                  h(
                    'div',
                    { class: 'row' },
                    email,
                    button('Add', async () => {
                      await api('/v1/control/suppressions/update', { method: 'POST', body: { email: email.value.trim(), action: 'add' } });
                      await drawSuppressions();
                    }, { variant: 'ghost' }),
                  ),
                  table(
                    [
                      { label: 'Email', render: (row) => row.email },
                      { label: 'Why', render: (row) => row.reason },
                      { label: 'Since', render: (row) => ago(row.createdAt) },
                      {
                        label: '',
                        render: (row) =>
                          button('Remove', async () => {
                            if (row.reason === 'unsubscribed' && !(await confirmDialog({ title: 'Remove an unsubscribe?', body: ['This person asked not to be contacted. Only remove this if they asked again to hear from you.'], confirm: 'Remove' }))) return;
                            await api('/v1/control/suppressions/update', { method: 'POST', body: { email: row.email, action: 'remove' } });
                            await drawSuppressions();
                          }, { small: true, variant: 'quiet' }),
                      },
                    ],
                    suppressions,
                    { emptyText: 'Nobody is suppressed. Unsubscribes and bounces are added automatically.' },
                  ),
                );
              };
              await drawSuppressions();
              return holder;
            },
          ],
        ]),
      ),
    );
  };
  await draw();
  return root;
}

import { ago, button, clear, confirmDialog, empty, emptyState, eyebrow, field, h, input, note, pill, secretDialog, select, surface, tabs, textarea, toast } from '../ui.js';

const ROLE = { owner: 'Owner', admin: 'Admin', member: 'Member' };

function shareView(share, { api, me, back }) {
  const body = textarea({ rows: 3, maxLength: 5_000, placeholder: 'Internal comment. Never sent to the customer.', attrs: { 'aria-label': 'Comment' } });
  return h(
    'div',
    { class: 'stack' },
    h('button', { type: 'button', class: 'back', on: { click: () => back() } }, '← Team'),
    surface(
      'card',
      {},
      h('header', { class: 'detail-head' }, h('div', {}, eyebrow(`${share.workspaceName} · shared by ${share.sharedBy.name} ${ago(share.sharedAt)}`), h('h2', {}, share.subject ?? 'Shared thread')), share.assignment ? pill(share.assignment.status === 'done' ? 'Done' : 'Open', share.assignment.status === 'done' ? 'good' : 'warn') : null),
      share.summary ? h('p', {}, share.summary) : null,
      share.participants ? h('p', { class: 'muted' }, share.participants.join(', ')) : null,
      share.assignment ? h('p', {}, h('strong', {}, 'Assigned to '), share.assignment.assignee.name, share.assignment.note ? ` — “${share.assignment.note}”` : '') : null,
      h('p', { class: 'hint' }, `The sharer chose what you can see: ${share.fields.join(', ')}. The email itself stays in their mailbox.`),
      share.assignment && share.assignment.status === 'open'
        ? h('div', { class: 'row' }, button('Mark done', async () => {
            const { share: updated } = await api('/v1/team/assignment', { method: 'POST', body: { assignmentId: share.assignment.id, status: 'done' } });
            toast('Marked done.', 'success');
            back(updated);
          }))
        : null,
    ),
    surface(
      'ledger',
      { title: 'Comments' },
      share.comments.length
        ? h('ul', { class: 'list' }, share.comments.map((comment) => h('li', {}, h('div', { class: 'list-main' }, h('strong', {}, comment.author.name), h('span', { class: 'muted' }, ago(comment.createdAt))), h('p', {}, comment.body))))
        : empty('No comments yet.'),
      body,
      h('div', { class: 'row' }, button('Comment', async () => {
        if (!body.value.trim()) throw new Error('Write something first.');
        const { share: updated } = await api('/v1/team/comment', { method: 'POST', body: { shareId: share.id, body: body.value.trim(), mentions: [] } });
        back(updated);
      })),
    ),
  );
}

function workspaceCard(workspace, { api, me, redraw }) {
  const admin = workspace.role === 'owner' || workspace.role === 'admin';
  const email = input({ type: 'email', placeholder: 'teammate@company.com', attrs: { 'aria-label': 'Email to invite' } });
  const role = select([['member', 'Member'], ['admin', 'Admin']], 'member', { attrs: { 'aria-label': 'Role' } });
  return surface(
    'card',
    { tag: 'article', eyebrow: `Workspace · ${workspace.members.length} ${workspace.members.length === 1 ? 'member' : 'members'}`, title: workspace.name, actions: pill(ROLE[workspace.role], 'neutral') },
    h(
      'ul',
      { class: 'list' },
      workspace.members.map((member) =>
        h(
          'li',
          {},
          h('div', { class: 'list-main' }, h('strong', {}, member.name || member.email), h('span', { class: 'muted' }, `${member.email} · ${ROLE[member.role]}`)),
          admin && member.role !== 'owner' && member.userId !== me.user.id
            ? h(
                'div',
                { class: 'row' },
                button(member.role === 'admin' ? 'Make member' : 'Make admin', async () => {
                  await api('/v1/control/workspaces/member', { method: 'POST', body: { workspaceId: workspace.id, userId: member.userId, role: member.role === 'admin' ? 'member' : 'admin' } });
                  await redraw();
                }, { small: true, variant: 'ghost' }),
                button('Remove', async () => {
                  if (!(await confirmDialog({ title: `Remove ${member.name || member.email}?`, body: ['They lose access to everything shared in this workspace immediately.'], confirm: 'Remove', danger: true }))) return;
                  await api('/v1/control/workspaces/member', { method: 'POST', body: { workspaceId: workspace.id, userId: member.userId, remove: true } });
                  await redraw();
                }, { small: true, variant: 'danger-ghost' }),
              )
            : null,
        ),
      ),
    ),
    admin
      ? h(
          'div',
          { class: 'row' },
          email,
          role,
          button('Invite', async () => {
            const { url } = await api('/v1/control/workspaces/invite', { method: 'POST', body: { workspaceId: workspace.id, email: email.value.trim(), role: role.value } });
            email.value = '';
            await secretDialog('Invitation link', url, ['Send this link to your teammate. It works once, only for that email address, for 14 days.']);
          }, { variant: 'ghost' }),
        )
      : null,
  );
}

async function snippets(api, workspaces) {
  const holder = h('div', { class: 'stack' });
  const draw = async () => {
    const { snippets: items } = await api('/v1/snippets');
    const name = input({ maxLength: 120, attrs: { 'aria-label': 'Snippet name' } });
    const body = textarea({ rows: 5, maxLength: 10_000, placeholder: 'Hi {first_name}, thanks for … {AI: one sentence about what they asked}' });
    const scope = select([['', 'Just me'], ...workspaces.map((workspace) => [workspace.id, `Shared with ${workspace.name}`])], '');
    clear(
      holder,
      surface(
        'slip',
        { title: 'New snippet', className: 'composer' },
        h('p', { class: 'hint' }, 'Use {variables} for values you fill in, and {AI: …} for a sentence PigeonBox writes from the thread. AI parts never invent facts; missing ones become placeholders.'),
        field('Name', name),
        field('Text', body),
        field('Who can use it', scope),
        h('div', { class: 'row' }, button('Save snippet', async () => {
          await api('/v1/snippets/save', { method: 'POST', body: { name: name.value.trim(), body: body.value, workspaceId: scope.value || null } });
          toast('Saved.', 'success');
          await draw();
        })),
      ),
      items.length
        ? surface(
            'ledger',
            { title: 'Snippets' },
            h(
              'ul',
              { class: 'list' },
              items.map((snippet) =>
                h(
                  'li',
                  {},
                  h('div', { class: 'list-main' }, h('strong', {}, snippet.name), h('span', { class: 'muted' }, `${snippet.scope === 'workspace' ? 'Shared' : 'Personal'} · ${snippet.variables.length} fields · ${snippet.directives.length} AI parts · ${ago(snippet.updatedAt)}`)),
                  button('Delete', async () => {
                    if (!(await confirmDialog({ title: `Delete “${snippet.name}”?`, body: ['It disappears from the extension for everyone who uses it.'], confirm: 'Delete', danger: true }))) return;
                    await api('/v1/snippets/delete', { method: 'POST', body: { id: snippet.id } });
                    await draw();
                  }, { small: true, variant: 'danger-ghost' }),
                ),
              ),
            ),
          )
        : empty('No snippets yet.'),
    );
  };
  await draw();
  return holder;
}

export async function render({ api, me, caps, landing }) {
  const root = h('div');
  let banner = null;
  if (landing.invite) {
    const token = landing.invite;
    delete landing.invite;
    try {
      await api('/v1/control/workspaces/accept', { method: 'POST', body: { token } });
      banner = note('You joined the workspace.', 'success');
    } catch (error) {
      banner = note(error.message || 'This invitation could not be accepted.', 'error');
    }
  }

  const draw = async (openShare = null) => {
    if (openShare) return clear(root, shareView(openShare, { api, me, back: (updated) => draw(updated ?? null) }));
    const [{ workspaces }, { shares }] = await Promise.all([api('/v1/workspaces'), api('/v1/control/team/assigned')]);
    const name = input({ maxLength: 120, placeholder: 'e.g. Sales', attrs: { 'aria-label': 'Workspace name' } });
    const openById = async (id) => {
      const { share } = await api('/v1/control/team/share', { method: 'POST', body: { shareId: id } });
      await draw(share);
    };
    const items = [
      [
        'workspaces',
        'Workspaces',
        async () =>
          h(
            'div',
            { class: 'stack' },
            workspaces.length ? workspaces.map((workspace) => workspaceCard(workspace, { api, me, redraw: () => draw() })) : emptyState({ state: 'wave', title: 'You are not in a workspace yet.', text: 'Create one below, then invite teammates by email. Shared threads carry only the summary the sharer chooses.' }),
            surface('slip', { title: 'New workspace' }, h('div', { class: 'row tight' }, name, button('Create', async () => {
              if (!name.value.trim()) throw new Error('Name the workspace.');
              await api('/v1/control/workspaces/create', { method: 'POST', body: { name: name.value.trim() } });
              await draw();
            }, { variant: 'ghost' }))),
          ),
      ],
      [
        'assigned',
        `Assigned to me${shares.filter((share) => share.assignment?.status === 'open').length ? ` (${shares.filter((share) => share.assignment?.status === 'open').length})` : ''}`,
        async () =>
          shares.length
            ? h(
                'ul',
                { class: 'list selectable' },
                shares.map((share) =>
                  h(
                    'li',
                    {},
                    h('button', { type: 'button', class: 'list-button', on: { click: () => openById(share.id) } }, h('strong', {}, share.subject ?? 'Shared thread'), h('span', { class: 'muted' }, `${share.workspaceName} · from ${share.sharedBy.name} · ${ago(share.sharedAt)}`)),
                    share.assignment ? pill(share.assignment.status === 'done' ? 'Done' : 'Open', share.assignment.status === 'done' ? 'good' : 'warn') : null,
                  ),
                ),
              )
            : empty('Nothing is assigned to you. Teammates assign threads from Gmail’s side panel.'),
      ],
    ];
    if (caps.has('cloud_ai')) items.push(['snippets', 'Snippets', () => snippets(api, workspaces)]);
    clear(root, h('div', { class: 'stack' }, banner, tabs(items)));
  };
  await draw();
  return root;
}

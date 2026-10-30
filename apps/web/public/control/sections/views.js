import { ago, button, clear, confirmDialog, empty, eyebrow, field, h, input, note, pill, surface, tabs, textarea, toast } from '../ui.js';
import { accountEmails, actionLabel, gmailLink } from '../shared.js';

const MODE = { view: ['View', 'neutral'], shadow: ['Shadow Mode', 'info'], active: ['Active', 'good'] };
const modePill = (view) => (view.enabled ? pill(...MODE[view.mode]) : pill('Paused', 'neutral'));

function saveBody(view, overrides = {}) {
  return { id: view.id, name: view.name, prompt: view.prompt, filter: view.filter, actions: view.actions, mode: view.mode, enabled: view.enabled, priority: view.priority, ...overrides };
}

function explanation(lines) {
  return h('ul', { class: 'explain' }, lines.map((line) => h('li', {}, line)));
}

async function detail(view, { api, emails, back }) {
  const stats = view.stats;
  const actions = h(
    'div',
    { class: 'row' },
    view.mode === 'shadow'
      ? button('Turn on', async () => {
          const ok = await confirmDialog({
            title: `Turn on “${view.name}”?`,
            body: [`From now on it will ${view.actions.map(actionLabel).join(', ').toLowerCase()} for matching mail. Every change is logged in Activity and can be undone.`],
            confirm: 'Turn on',
          });
          if (!ok) return;
          await api('/v1/views/activate', { method: 'POST', body: { id: view.id } });
          toast('Turned on.', 'success');
          back(view.id);
        }, { disabled: !view.activation.eligible, title: view.activation.eligible ? undefined : view.activation.reason })
      : null,
    button(view.enabled ? 'Pause' : 'Resume', async () => {
      await api('/v1/views/save', { method: 'POST', body: saveBody(view, { enabled: !view.enabled }) });
      back(view.id);
    }, { variant: 'ghost' }),
    button('Delete…', async () => {
      if (!(await confirmDialog({ title: `Delete “${view.name}”?`, body: ['The view and its history are removed. Changes it already made stay in Gmail and remain undoable from Activity.'], confirm: 'Delete', danger: true }))) return;
      await api('/v1/views/delete', { method: 'POST', body: { id: view.id } });
      toast('Deleted.', 'success');
      back(null);
    }, { variant: 'danger-ghost' }),
  );

  const matches = async () => {
    const result = await api('/v1/views/results', { method: 'POST', body: { id: view.id, limit: 40 } });
    return h(
      'div',
      {},
      result.items.length
        ? h(
            'ul',
            { class: 'list' },
            result.items.map((item) =>
              h('li', {}, h('div', { class: 'list-main' }, gmailLink(item.subject || '(no subject)', emails.get(item.accountId), item.threadId), h('span', { class: 'muted' }, `${item.who} · ${ago(item.lastMessageAt)}`)), h('p', { class: 'why' }, item.why.join(' · '))),
            ),
          )
        : empty('No synced threads match right now.'),
      h('p', { class: 'hint' }, result.note),
    );
  };

  const shadow = async () => {
    const holder = h('div');
    const draw = async () => {
      const result = await api('/v1/views/shadow', { method: 'POST', body: { id: view.id } });
      const pending = result.decisions.filter((decision) => decision.verdict === 'pending');
      clear(
        holder,
        note(result.activation.eligible ? 'Enough confirmed examples. You can turn this on.' : result.activation.reason, result.activation.eligible ? 'success' : 'info'),
        h('p', { class: 'hint' }, `${result.activation.confirmed} of ${result.activation.required} confirmed · ${result.stats.corrected} corrected`),
        result.decisions.length
          ? h(
              'ul',
              { class: 'list' },
              result.decisions.map((decision) =>
                h(
                  'li',
                  {},
                  h('div', { class: 'list-main' }, h('strong', {}, decision.subject || '(no subject)'), h('span', { class: 'muted' }, `${decision.who} · would ${decision.actions.map(actionLabel).join(', ').toLowerCase()}`)),
                  h('p', { class: 'why' }, decision.why.join(' · ')),
                  decision.verdict === 'pending'
                    ? h(
                        'div',
                        { class: 'row' },
                        button('Correct', async () => {
                          await api('/v1/views/review', { method: 'POST', body: { decisionId: decision.id, verdict: 'correct' } });
                          await draw();
                        }, { small: true, variant: 'ghost' }),
                        button('Wrong', async () => {
                          await api('/v1/views/review', { method: 'POST', body: { decisionId: decision.id, verdict: 'incorrect' } });
                          toast('Thanks. The rule now leaves mail like this alone.', 'success');
                          await draw();
                        }, { small: true, variant: 'quiet' }),
                      )
                    : pill(decision.verdict === 'correct' ? 'Confirmed' : 'Corrected', decision.verdict === 'correct' ? 'good' : 'warn'),
                ),
              ),
            )
          : empty('No decisions yet. As new mail arrives, PigeonBox records what this rule would have done, without touching Gmail.'),
        pending.length ? h('p', { class: 'hint' }, `${pending.length} waiting for your review.`) : null,
      );
    };
    await draw();
    return holder;
  };

  const history = async () => {
    const { versions } = await api('/v1/views/history', { method: 'POST', body: { id: view.id } });
    return h(
      'ul',
      { class: 'list' },
      versions.map((version) => h('li', {}, h('div', { class: 'list-main' }, h('strong', {}, `Version ${version.version} · ${version.name}`), h('span', { class: 'muted' }, `${version.changedBy} · ${ago(version.changedAt)} · ${version.mode}`)))),
    );
  };

  const views = [['matches', 'Matches', matches]];
  if (view.actions.length) views.push(['shadow', 'Shadow review', shadow]);
  views.push(['history', 'History', history]);

  return h(
    'div',
    { class: 'stack' },
    h('button', { type: 'button', class: 'back', on: { click: () => back(null) } }, '← All Smart Views'),
    surface(
      'card',
      {},
      h('header', { class: 'detail-head' }, h('div', {}, eyebrow(`Smart View · v${view.version}`), h('h2', {}, view.name), h('p', { class: 'prompt' }, `“${view.prompt}”`)), modePill(view)),
      explanation(view.explanation),
      view.usesAi ? note('Part of this view needs AI judgment, so some matches can be wrong.', 'info') : null,
      view.actions.length ? h('p', {}, h('strong', {}, 'Does: '), view.actions.map(actionLabel).join(', ')) : null,
      h('p', { class: 'hint' }, `${stats.matched} matched · ${stats.applied} changes made · ${stats.undone} undone${stats.lastRunAt ? ` · last run ${ago(stats.lastRunAt)}` : ''}`),
      actions,
    ),
    tabs(views),
  );
}

export async function render(ctx) {
  const { api } = ctx;
  const emails = await accountEmails();
  const root = h('div');

  const drawList = async (openId = null) => {
    const { views } = await api('/v1/views');
    if (openId) {
      const view = views.find((item) => item.id === openId);
      if (view) return clear(root, await detail(view, { api, emails, back: drawList }));
    }
    const prompt = textarea({ rows: 2, placeholder: 'e.g. Receipts and confirmations, archive them', attrs: { 'aria-label': 'Describe the mail' } });
    const draftArea = h('div');
    const compile = button('Preview', async () => {
      const text = prompt.value.trim();
      if (text.length < 3) throw new Error('Describe which mail the view should hold.');
      const { draft } = await api('/v1/views/compile', { method: 'POST', body: { prompt: text } });
      const name = input({ value: draft.name, maxLength: 120 });
      clear(
        draftArea,
        h(
          'div',
          { class: 'draft-preview' },
          field('Name', name),
          h('p', { class: 'eyebrow' }, 'PigeonBox understood'),
          explanation(draft.explanation),
          draft.actions.length ? h('p', {}, h('strong', {}, 'Then: '), draft.actions.map(actionLabel).join(', ')) : null,
          draft.warnings.map((warning) => note(warning, 'info')),
          h(
            'div',
            { class: 'row' },
            button(draft.actions.length ? 'Save in Shadow Mode' : 'Save view', async () => {
              const { view } = await api('/v1/views/save', { method: 'POST', body: { name: name.value.trim() || draft.name, prompt: text, filter: draft.filter, actions: draft.actions, mode: draft.actions.length ? 'shadow' : 'view' } });
              toast(view.mode === 'shadow' ? 'Saved. It will record what it would do until you turn it on.' : 'Saved.', 'success');
              await drawList(view.id);
            }),
          ),
        ),
      );
    }, { variant: 'ghost', busy: 'Reading…' });

    clear(
      root,
      h(
        'div',
        { class: 'stack' },
        surface(
          'slip',
          { title: 'New Smart View', className: 'composer' },
          h('p', { class: 'muted' }, 'Describe the mail in your own words. PigeonBox turns it into rules you can read, and anything that would change Gmail starts in Shadow Mode.'),
          h('div', { class: 'field' }, prompt),
          h('div', { class: 'row tight' }, compile),
          draftArea,
        ),
        surface(
          'ledger',
          { title: 'Your views' },
          views.length
            ? h(
                'ul',
                { class: 'list selectable' },
                views.map((view) =>
                  h(
                    'li',
                    {},
                    h(
                      'button',
                      { type: 'button', class: 'list-button', on: { click: () => drawList(view.id) } },
                      h('strong', {}, view.name),
                      h('span', { class: 'muted' }, `${view.stats.matched} matched${view.actions.length ? ` · ${view.actions.map(actionLabel).join(', ')}` : ''}`),
                    ),
                    modePill(view),
                  ),
                ),
              )
            : empty('No Smart Views yet. Describe one above to see which synced mail it would hold.'),
        ),
      ),
    );
  };
  await drawList();
  return root;
}

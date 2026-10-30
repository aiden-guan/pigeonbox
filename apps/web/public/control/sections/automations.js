import { ago, button, clear, confirmDialog, empty, eyebrow, field, h, humanize, input, key, note, pill, select, surface, table, textarea, timeline, toast } from '../ui.js';
import { ACTIONS, tierPill } from '../shared.js';

const AUTONOMY = [
  ['suggest', 'Suggest only: everything that changes mail goes to Approvals'],
  ['auto_reversible', 'Do undoable changes (labels, archive); ask for the rest'],
  ['auto_draft', 'Also create visible drafts and holds; ask before sending'],
];

const runs = (tier, autonomy) => tier === 0 || (tier === 1 && autonomy !== 'suggest') || (tier === 2 && autonomy === 'auto_draft');

function tierTable(tiers, autonomy) {
  return table(
    [
      { label: 'Action', render: (row) => ACTIONS[row.kind] ?? humanize(row.kind) },
      { label: 'Risk', render: (row) => tierPill(row.tier) },
      { label: 'What happens', render: (row) => (runs(row.tier, autonomy) ? 'Runs automatically once turned on' : row.tier >= 3 ? 'Always waits for your approval' : 'Waits for your approval') },
    ],
    tiers,
  );
}

const modePill = (automation) => (!automation.enabled ? pill('Paused', 'neutral') : automation.mode === 'active' ? pill('On', 'good') : pill('Shadow Mode', 'info'));

function saveBody(automation, overrides = {}) {
  return {
    id: automation.id,
    name: automation.name,
    prompt: automation.prompt,
    trigger: automation.trigger,
    conditions: automation.conditions,
    context: automation.context,
    actions: automation.actions,
    autonomy: automation.autonomy,
    schedule: automation.schedule,
    mode: automation.mode,
    enabled: automation.enabled,
    ...overrides,
  };
}

const OUTCOME = { applied: ['Done', 'good'], shadowed: ['Would do', 'info'], approval_requested: ['Waiting for approval', 'warn'], skipped: ['Skipped', 'neutral'], failed: ['Failed', 'bad'] };
const RUN_TONE = { failed: 'bad', succeeded: 'good', completed: 'good', shadowed: 'quiet' };

async function detail(automation, { api, back }) {
  const autonomy = select(AUTONOMY, automation.autonomy);
  const tiersEl = h('div', {}, tierTable(automation.tiers, automation.autonomy));
  autonomy.addEventListener('change', () => clear(tiersEl, tierTable(automation.tiers, autonomy.value)));

  const runsEl = h('div');
  const drawRuns = async () => {
    const { runs: items } = await api('/v1/automations/runs', { method: 'POST', body: { id: automation.id, limit: 30 } });
    clear(
      runsEl,
      items.length
        ? timeline(
            items.map((run) => ({
              at: run.startedAt,
              title: `${humanize(run.trigger)} · ${humanize(run.status)}`,
              tone: RUN_TONE[run.status] ?? 'neutral',
              meta: run.actions.length ? null : 'No actions',
              aside: [
                h('div', { class: 'chips' }, run.actions.map((action) => pill(`${ACTIONS[action.kind] ?? action.kind}: ${(OUTCOME[action.outcome] ?? [action.outcome])[0]}${action.outcome === 'skipped' || action.outcome === 'failed' ? ` · ${action.detail}` : ''}`, (OUTCOME[action.outcome] ?? [0, 'neutral'])[1]))),
                run.actions.some((action) => action.approvalId) ? h('a', { href: '#approvals', class: 'text-link' }, 'Open Approvals') : null,
              ],
            })),
          )
        : empty('No runs yet. In Shadow Mode, each run records what this automation would have done.'),
    );
  };
  await drawRuns();

  const manual = automation.trigger.kind === 'schedule' || automation.trigger.kind === 'manual';
  return h(
    'div',
    { class: 'stack' },
    h('button', { type: 'button', class: 'back', on: { click: () => back(null) } }, '← All automations'),
    surface(
      'card',
      {},
      h('header', { class: 'detail-head' }, h('div', {}, eyebrow(`Automation · v${automation.version}`), h('h2', {}, automation.name), h('p', { class: 'prompt' }, `“${automation.prompt}”`)), modePill(automation)),
      h('ul', { class: 'explain' }, automation.explanation.map((line) => h('li', {}, line))),
      field('Autonomy', autonomy, 'Sending and invitations always need approval, whatever you choose.'),
      tiersEl,
      h('p', { class: 'hint' }, `${automation.stats.runs} runs · ${automation.stats.failures} failed${automation.stats.lastRunAt ? ` · last ${ago(automation.stats.lastRunAt)}` : ''}`),
      h(
        'div',
        { class: 'row' },
        automation.mode === 'shadow'
          ? button('Turn on', async () => {
              const ok = await confirmDialog({ title: `Turn on “${automation.name}”?`, body: ['It will act on new events as shown above. Every change is logged in Activity and undoable where possible.'], confirm: 'Turn on' });
              if (!ok) return;
              await api('/v1/automations/save', { method: 'POST', body: saveBody(automation, { mode: 'active', enabled: true }) });
              toast('Turned on.', 'success');
              back(automation.id);
            })
          : button('Back to Shadow Mode', async () => {
              await api('/v1/automations/save', { method: 'POST', body: saveBody(automation, { mode: 'shadow' }) });
              back(automation.id);
            }, { variant: 'ghost' }),
        button('Save autonomy', async () => {
          if (autonomy.value === automation.autonomy) return toast('Nothing changed.');
          const { automation: saved } = await api('/v1/automations/save', { method: 'POST', body: saveBody(automation, { autonomy: autonomy.value }) });
          toast(saved.mode === 'shadow' && automation.mode === 'active' ? 'Saved. Changing what it does put it back in Shadow Mode.' : 'Saved.', 'success');
          back(saved.id);
        }, { variant: 'ghost' }),
        button(automation.enabled ? 'Pause' : 'Resume', async () => {
          await api('/v1/automations/save', { method: 'POST', body: saveBody(automation, { enabled: !automation.enabled }) });
          back(automation.id);
        }, { variant: 'ghost' }),
        manual
          ? button('Run now', async () => {
              const { run } = await api('/v1/automations/run', { method: 'POST', body: { id: automation.id, idempotencyKey: key() } });
              toast(`Run ${humanize(run.status)}.`, run.status === 'failed' ? 'error' : 'success');
              await drawRuns();
            }, { variant: 'ghost', busy: 'Running…' })
          : null,
        button('Delete…', async () => {
          if (!(await confirmDialog({ title: `Delete “${automation.name}”?`, body: ['It stops immediately. Its past changes stay logged in Activity.'], confirm: 'Delete', danger: true }))) return;
          await api('/v1/automations/delete', { method: 'POST', body: { id: automation.id } });
          back(null);
        }, { variant: 'danger-ghost' }),
      ),
    ),
    surface('ledger', { title: 'Runs' }, runsEl),
  );
}

export async function render({ api }) {
  const root = h('div');
  const drawList = async (openId = null) => {
    const { automations } = await api('/v1/automations');
    if (openId) {
      const automation = automations.find((item) => item.id === openId);
      if (automation) return clear(root, await detail(automation, { api, back: drawList }));
    }
    const prompt = textarea({ rows: 2, placeholder: 'e.g. When a recruiter emails me, label it Recruiting and prepare a reply', attrs: { 'aria-label': 'Describe the automation' } });
    const draftArea = h('div');
    const compile = button('Preview', async () => {
      const text = prompt.value.trim();
      if (text.length < 3) throw new Error('Describe what should happen, and when.');
      const { draft } = await api('/v1/automations/compile', { method: 'POST', body: { prompt: text } });
      const name = input({ value: draft.name, maxLength: 120 });
      const autonomy = select(AUTONOMY, draft.autonomy);
      const tiersEl = h('div', {}, tierTable(draft.tiers, draft.autonomy));
      autonomy.addEventListener('change', () => clear(tiersEl, tierTable(draft.tiers, autonomy.value)));
      clear(
        draftArea,
        h(
          'div',
          { class: 'draft-preview' },
          field('Name', name),
          h('p', { class: 'eyebrow' }, 'PigeonBox understood'),
          h('ul', { class: 'explain' }, draft.explanation.map((line) => h('li', {}, line))),
          draft.warnings.map((warning) => note(warning, 'info')),
          field('Autonomy', autonomy),
          tiersEl,
          h(
            'div',
            { class: 'row' },
            button('Save in Shadow Mode', async () => {
              const { automation } = await api('/v1/automations/save', {
                method: 'POST',
                body: { name: name.value.trim() || draft.name, prompt: text, trigger: draft.trigger, conditions: draft.conditions, context: draft.context, actions: draft.actions, autonomy: autonomy.value, schedule: draft.schedule, mode: 'shadow' },
              });
              toast('Saved in Shadow Mode. Review its runs, then turn it on.', 'success');
              await drawList(automation.id);
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
          { title: 'New automation', className: 'composer' },
          h('p', { class: 'muted' }, 'Say what should happen and when, in plain words. You will see exactly what it does and which steps need your approval before anything runs.'),
          h('div', { class: 'field' }, prompt),
          h('div', { class: 'row tight' }, compile),
          draftArea,
        ),
        surface(
          'ledger',
          { title: 'Your automations', actions: automations.length ? pill(`${automations.filter((item) => item.enabled && item.mode === 'active').length} on`, 'neutral') : null },
          automations.length
            ? h(
                'ul',
                { class: 'list selectable' },
                automations.map((automation) =>
                  h(
                    'li',
                    {},
                    h(
                      'button',
                      { type: 'button', class: 'list-button', on: { click: () => drawList(automation.id) } },
                      h('strong', {}, automation.name),
                      h('span', { class: 'muted' }, [automation.explanation[0] ?? '', automation.stats?.lastRunAt ? `last ran ${ago(automation.stats.lastRunAt)}` : null].filter(Boolean).join(' · ')),
                    ),
                    modePill(automation),
                  ),
                ),
              )
            : empty('No automations yet. Describe one above; it starts in Shadow Mode, so nothing changes until you turn it on.'),
        ),
      ),
    );
  };
  await drawList();
  return root;
}

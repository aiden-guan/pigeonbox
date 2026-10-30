import { ago, button, clear, empty, eyebrow, h, link, loading, surface, when } from '../ui.js';
import { accountEmails, gmailLink } from '../shared.js';

const KIND = { morning: 'Morning', end_of_day: 'End of day', meeting: 'Meeting' };

function briefingView(briefing, emails) {
  const sources = new Map(briefing.sources.map((source) => [source.id, source]));
  return h(
    'article',
    { class: 'card briefing' },
    h('header', { class: 'detail-head' }, h('div', {}, eyebrow(`Prepared ${when(briefing.generatedAt)}`), h('h2', {}, briefing.title))),
    briefing.sections.map((section) =>
      h(
        'section',
        { class: 'brief-section' },
        h('h3', {}, section.title),
        section.items.length
          ? h(
              'ul',
              { class: 'list' },
              section.items.map((item) =>
                h(
                  'li',
                  {},
                  h(
                    'div',
                    { class: 'list-main' },
                    h('span', {}, item.text),
                    item.sourceIds.length
                      ? h(
                          'span',
                          { class: 'sources' },
                          item.sourceIds.map((id) => {
                            const source = sources.get(id);
                            if (!source) return null;
                            if (source.gmailThreadId) return gmailLink(source.title, emails.get(source.accountId), source.gmailThreadId);
                            if (source.url) return h('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer', class: 'source' }, source.title);
                            return h('span', { class: 'source' }, source.title);
                          }),
                        )
                      : null,
                  ),
                ),
              ),
            )
          : h('p', { class: 'muted' }, section.empty ?? 'Nothing here.'),
      ),
    ),
    h('p', { class: 'hint' }, briefing.coverageNote),
  );
}

export async function render({ api }) {
  const emails = await accountEmails();
  const detail = h('div');
  const listEl = h('div');

  const open = async (id) => {
    clear(detail, loading('Loading briefing…'));
    const { briefing } = await api('/v1/briefings/get', { method: 'POST', body: { id } });
    clear(detail, briefingView(briefing, emails));
  };

  const drawList = async () => {
    const { briefings } = await api('/v1/briefings/list', { method: 'POST', body: { limit: 20 } });
    clear(
      listEl,
      briefings.length
        ? h(
            'ul',
            { class: 'list selectable' },
            briefings.map((item) =>
              h('li', {}, h('button', { type: 'button', class: 'list-button', on: { click: () => open(item.id) } }, h('strong', {}, item.title), h('span', { class: 'muted' }, `${KIND[item.kind] ?? item.kind} · ${ago(item.generatedAt)}`))),
            ),
          )
        : empty('No briefings yet. Morning briefings arrive on workdays at the time you choose in Preferences.'),
    );
    if (briefings[0]) await open(briefings[0].id);
    else clear(detail);
  };

  const generate = (kind) =>
    button(kind === 'morning' ? 'Prepare morning briefing' : 'Prepare end-of-day wrap-up', async () => {
      const { briefing } = await api('/v1/briefings/generate', { method: 'POST', body: { kind } });
      await drawList();
      clear(detail, briefingView(briefing, emails));
    }, { variant: kind === 'morning' ? 'primary' : 'ghost', busy: 'Preparing…' });

  await drawList();
  return h(
    'div',
    { class: 'stack' },
    h('div', { class: 'row tight' }, generate('morning'), generate('end_of_day'), link('Briefing times', '#preferences', { class: 'btn btn-quiet' })),
    h('div', { class: 'grid-sidebar' }, surface('ledger', { title: 'Recent' }, listEl), detail),
  );
}

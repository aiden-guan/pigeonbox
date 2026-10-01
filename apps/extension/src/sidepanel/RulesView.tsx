import { trackProductEvent } from '../ui/analytics';
import { useCallback, useEffect, useState } from 'react';
import type { RouteResponse, SmartView, Automation, ActionSpec } from '@pigeonbox/api-contract';
import { callCloud } from './cloud-api';
import { openCloud } from '../ui/cloud-features';
import { relative } from './WaitingView';
import { Orb } from '../ui/Orb';

const words = (text: string) => text.replace(/_/g, ' ');
function Actions({ actions }: { actions: ActionSpec[] }) {
  return (
    <ul>
      {actions.map((action, index) => (
        <li key={index}>
          <strong>{words(action.kind)}</strong>
          {Object.entries(action.params).length
            ? ` · ${Object.entries(action.params)
                .map(([key, value]) => `${words(key)}: ${value}`)
                .join(', ')}`
            : ''}
        </li>
      ))}
    </ul>
  );
}

export function RulesView({
  kind,
  onOpenThread,
}: {
  kind: 'views' | 'automations';
  onOpenThread: (id: string, accountId?: string) => void;
}) {
  const isView = kind === 'views';
  const [items, setItems] = useState<Array<SmartView | Automation> | null>(null);
  const [prompt, setPrompt] = useState('');
  const [compiled, setCompiled] = useState<
    RouteResponse<'viewCompile'>['draft'] | RouteResponse<'automationCompile'>['draft'] | null
  >(null);
  const [selected, setSelected] = useState<SmartView | Automation | null>(null);
  const [matches, setMatches] = useState<RouteResponse<'viewResults'> | null>(null);
  const [shadow, setShadow] = useState<RouteResponse<'viewShadow'> | null>(null);
  const [runs, setRuns] = useState<RouteResponse<'automationRuns'>['runs'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    const result = await callCloud(kind);
    if (result.ok) {
      setItems('views' in result.data ? result.data.views : result.data.automations);
    } else setError(result.reason);
  }, [kind]);
  useEffect(() => {
    void load();
  }, [load]);
  async function compile() {
    setBusy(true);
    setError('');
    setNotice('');
    setCompiled(null);
    const result = await callCloud(isView ? 'viewCompile' : 'automationCompile', { prompt: prompt.trim() });
    setBusy(false);
    if (result.ok) setCompiled(result.data.draft);
    else setError(result.reason);
  }
  async function save() {
    if (!compiled) return;
    setBusy(true);
    setError('');
    const result =
      'filter' in compiled
        ? await callCloud('viewSave', {
            name: compiled.name,
            prompt,
            filter: compiled.filter,
            actions: compiled.actions,
            mode: 'shadow',
          })
        : await callCloud('automationSave', {
            name: compiled.name,
            prompt,
            trigger: compiled.trigger,
            conditions: compiled.conditions,
            context: compiled.context,
            actions: compiled.actions,
            autonomy: compiled.autonomy,
            schedule: compiled.schedule,
            mode: 'shadow',
          });
    setBusy(false);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    trackProductEvent(isView ? 'smart_view_created' : 'automation_created', { surface: 'sidepanel', mode: 'cloud' });
    setCompiled(null);
    setPrompt('');
    setNotice('Saved in Shadow Mode. Nothing changes in Gmail. Review decisions before enabling actions.');
    void load();
  }
  async function inspect(item: SmartView | Automation) {
    setSelected(item);
    setBusy(true);
    setError('');
    setMatches(null);
    setShadow(null);
    setRuns(null);
    if ('filter' in item) {
      const [a, b] = await Promise.all([
        callCloud('viewResults', { id: item.id, limit: 10 }),
        callCloud('viewShadow', { id: item.id }),
      ]);
      if (a.ok) setMatches(a.data);
      else setError(a.reason);
      if (b.ok) setShadow(b.data);
      else setError(b.reason);
    } else {
      const result = await callCloud('automationRuns', { id: item.id, limit: 10 });
      if (result.ok) setRuns(result.data.runs);
      else setError(result.reason);
    }
    setBusy(false);
  }
  async function review(decisionId: string, verdict: 'correct' | 'incorrect') {
    setBusy(true);
    setError('');
    const result = await callCloud('viewReview', { decisionId, verdict });
    setBusy(false);
    if (result.ok) {
      setShadow(result.data);
      setNotice(
        verdict === 'correct'
          ? 'Marked correct. This does not activate the rule.'
          : 'Marked wrong. The feedback is recorded.',
      );
      void load();
    } else setError(result.reason);
  }
  return (
    <section className="gi-cloud-reader">
      <div className="gi-cloud-section-head">
        <h2>{isView ? 'Smart Views' : 'Automations'}</h2>
        <button type="button" className="gi-text-btn" onClick={() => openCloud(kind)}>
          Manage ↗
        </button>
      </div>
      <p className="gi-muted">
        {isView
          ? 'Find mail by intent. Preview what a rule would change before turning it on.'
          : 'Prepare and organize work using the existing Cloud policy. New automations start in Shadow Mode.'}
      </p>
      {notice ? (
        <p className="gi-note" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="gi-warn" role="alert">
          {error}
          <button
            className="gi-text-btn"
            type="button"
            onClick={() => (selected ? void inspect(selected) : void load())}
          >
            Retry
          </button>
        </p>
      ) : null}
      {selected ? (
        <>
          <button
            className="gi-text-btn"
            type="button"
            onClick={() => {
              setSelected(null);
              setError('');
            }}
          >
            ← All {isView ? 'Smart Views' : 'automations'}
          </button>
          <h3>{selected.name}</h3>
          <p>
            {!selected.enabled
              ? 'Paused'
              : selected.mode === 'shadow'
                ? 'Shadow Mode'
                : selected.mode === 'active'
                  ? 'On'
                  : 'View only'}
          </p>
          <ul>
            {selected.explanation.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
          <Actions actions={selected.actions} />
          {busy ? (
            <p className="gi-orb-line" role="status">
              <Orb size={16} />
              Loading recent work…
            </p>
          ) : null}
          {matches ? (
            <section className="gi-cloud-block">
              <h3>Recent matches</h3>
              {matches.items.map((item) => (
                <div key={`${item.accountId}-${item.threadId}`}>
                  <button
                    type="button"
                    className="gi-source"
                    onClick={() => onOpenThread(item.threadId, item.accountId)}
                  >
                    {item.subject}
                  </button>
                  <p className="gi-muted">{item.why.join(' · ')}</p>
                </div>
              ))}
              {!matches.items.length ? (
                <p className="gi-muted">No matching threads in the available synced mail.</p>
              ) : null}
              <p className="gi-muted">{matches.note}</p>
            </section>
          ) : null}
          {shadow ? (
            <section className="gi-cloud-block">
              <h3>Shadow reviews</h3>
              <p className="gi-muted">{shadow.activation.reason} Nothing changes in Gmail during review.</p>
              {shadow.decisions
                .filter((decision) => decision.verdict === 'pending')
                .map((decision) => (
                  <div className="gi-shadow-decision" key={decision.id}>
                    <strong>{decision.subject}</strong>
                    <p>{decision.why.join(' · ')}</p>
                    <Actions actions={decision.actions} />
                    <div className="gi-cloud-actions">
                      <button
                        className="gi-btn gi-btn-ghost"
                        type="button"
                        disabled={busy}
                        onClick={() => void review(decision.id, 'correct')}
                      >
                        Correct
                      </button>
                      <button
                        className="gi-btn gi-btn-ghost"
                        type="button"
                        disabled={busy}
                        onClick={() => void review(decision.id, 'incorrect')}
                      >
                        Wrong
                      </button>
                    </div>
                  </div>
                ))}
              {!shadow.decisions.some((decision) => decision.verdict === 'pending') ? (
                <p className="gi-muted">No pending Shadow reviews.</p>
              ) : null}
            </section>
          ) : null}
          {runs ? (
            <section className="gi-cloud-block">
              <h3>Recent runs</h3>
              {runs.length ? (
                runs.map((run) => (
                  <div className="gi-shadow-decision" key={run.id}>
                    <strong>
                      {words(run.status)} · {relative(run.startedAt)}
                    </strong>
                    <ul>
                      {run.actions.map((action, index) => (
                        <li key={index}>
                          {words(action.kind)} · {words(action.outcome)}
                          {action.detail ? ` · ${action.detail}` : ''}
                        </li>
                      ))}
                    </ul>
                    {run.status === 'failed' ? (
                      <p className="gi-warn">This run did not complete. Review it in Cloud before retrying.</p>
                    ) : null}
                  </div>
                ))
              ) : (
                <p className="gi-muted">No runs yet.</p>
              )}
            </section>
          ) : null}
          <button className="gi-btn gi-btn-ghost" type="button" onClick={() => openCloud(kind)}>
            Review activation in Cloud ↗
          </button>
        </>
      ) : (
        <>
          {!items && !error ? (
            <p className="gi-muted" role="status">
              Loading…
            </p>
          ) : items?.length ? (
            items.map((item) => (
              <button
                className="gi-automatic-row"
                type="button"
                key={item.id}
                disabled={busy}
                onClick={() => void inspect(item)}
              >
                <strong>{item.name}</strong>
                <span>
                  {!item.enabled
                    ? 'Paused'
                    : item.mode === 'shadow'
                      ? 'Shadow Mode'
                      : item.mode === 'active'
                        ? 'On'
                        : 'View only'}{' '}
                  ·{' '}
                  {'filter' in item
                    ? `${item.stats.matched} matches · ${Math.max(0, item.stats.shadowDecisions - item.stats.confirmed - item.stats.corrected)} reviews pending`
                    : `${item.stats.runs} runs · ${item.stats.failures} failures`}
                  {item.stats.lastRunAt ? ` · ${relative(item.stats.lastRunAt)}` : ''}
                </span>
              </button>
            ))
          ) : items ? (
            <p className="gi-muted">No {isView ? 'Smart Views' : 'automations'} yet.</p>
          ) : null}
          <section className="gi-cloud-block">
            <h3>New {isView ? 'Smart View' : 'automation'}</h3>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void compile();
              }}
            >
              <label className="gi-muted" htmlFor="gi-rule-prompt">
                Describe the mail and what should happen
              </label>
              <textarea
                className="gi-field"
                id="gi-rule-prompt"
                value={prompt}
                disabled={busy}
                maxLength={isView ? 500 : 1000}
                placeholder={
                  isView
                    ? 'Receipts and confirmations, archive them'
                    : 'When a recruiter emails me, label it Recruiting and prepare a reply.'
                }
                onChange={(event) => {
                  setPrompt(event.target.value);
                  setCompiled(null);
                }}
              />
              <button type="submit" className="gi-btn gi-btn-ghost" disabled={busy || prompt.trim().length < 3}>
                {busy ? 'Working…' : 'Preview'}
              </button>
            </form>
            {compiled ? (
              <div className="gi-rule-preview">
                <h3>PigeonBox understood: {compiled.name}</h3>
                {'trigger' in compiled ? (
                  <p>
                    <strong>Trigger:</strong> {words(compiled.trigger.kind)}
                    {Object.entries(compiled.trigger.params)
                      .map(([key, value]) => ` · ${words(key)}: ${value}`)
                      .join('')}
                  </p>
                ) : null}
                <strong>When</strong>
                <ul>
                  {compiled.explanation.map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ul>
                <strong>Then</strong>
                <Actions actions={compiled.actions} />
                {'autonomy' in compiled ? (
                  <>
                    <p>
                      <strong>Autonomy:</strong> {words(compiled.autonomy)}
                    </p>
                    <ul>
                      {compiled.tiers.map((tier, index) => (
                        <li key={index}>
                          {words(tier.kind)} ·{' '}
                          {tier.tier === 3
                            ? 'Always needs approval'
                            : tier.runsAutomatically
                              ? 'May run after explicit activation'
                              : 'Requires approval'}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                <details>
                  <summary>Full compiled conditions</summary>
                  <pre className="gi-compiled-spec">
                    {JSON.stringify('filter' in compiled ? compiled.filter : compiled.conditions, null, 2)}
                  </pre>
                </details>
                {compiled.warnings.map((warning, index) => (
                  <p className="gi-warn" key={index}>
                    {warning}
                  </p>
                ))}
                <p>Mode: Shadow Mode. Sending and invitations always require approval.</p>
                <div className="gi-cloud-actions">
                  <button className="gi-btn" type="button" disabled={busy} onClick={() => void save()}>
                    Save in Shadow Mode
                  </button>
                  <button
                    className="gi-btn gi-btn-ghost"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setCompiled(null);
                      document.getElementById('gi-rule-prompt')?.focus();
                    }}
                  >
                    Edit
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        </>
      )}
    </section>
  );
}

import { Brand, Pigeon } from '../ui/Pigeon';
import { useCallback, useEffect, useState } from 'react';
import type { ExtensionSettings } from '@pigeonbox/shared';
import { DEFAULT_SETTINGS } from '@pigeonbox/shared';
import { Orb } from '../ui/Orb';
import { relative, stamp, WaitingView } from './WaitingView';
import { CloudView } from './CloudView';

type SplitCategory =
  | 'PRIORITY'
  | 'RESPOND'
  | 'WAITING'
  | 'FYI'
  | 'NOTIFICATIONS'
  | 'PROMOTIONS'
  | 'NEWS'
  | 'FOLLOW_UPS';

type SplitThread = {
  threadId: string;
  subject: string;
  sender: string;
  snippet: string;
  timestamp: string;
  priority?: string;
  manual?: boolean;
};

type AskItem = {
  threadId: string | null;
  subject: string;
  who: string;
  timestamp: string | null;
  status?: string;
  opened?: boolean;
};

type AskDraft = {
  to: Array<{ email: string; name?: string }>;
  subject: string;
  body: string;
};

type AskResult = {
  answer?: string;
  citations?: Array<{ threadId: string; subject: string }>;
  items?: AskItem[];
  draft?: AskDraft;
  coverageNote?: string;
  error?: string;
};

const CATEGORIES: Array<[SplitCategory, string]> = [
  ['PRIORITY', 'Priority'],
  ['RESPOND', 'Respond'],
  ['WAITING', 'Waiting'],
  ['FYI', 'FYI'],
  ['NOTIFICATIONS', 'Notifications'],
  ['PROMOTIONS', 'Promotions'],
  ['NEWS', 'News'],
  ['FOLLOW_UPS', 'Follow-ups'],
];

export function SidePanelApp() {
  const [mode, setMode] = useState<'inbox' | 'ask' | 'cloud'>('inbox');
  const [cloudAvailable, setCloudAvailable] = useState(false);
  const [approvalCount, setApprovalCount] = useState(0);
  const [category, setCategory] = useState<SplitCategory>('RESPOND');
  const [threads, setThreads] = useState<SplitThread[]>([]);
  const [coverage, setCoverage] = useState('');
  const [query, setQuery] = useState('');
  const [asked, setAsked] = useState('');
  const [loading, setLoading] = useState(false);
  const [draftState, setDraftState] = useState<'opening' | 'opened' | 'failed' | null>(null);
  const [result, setResult] = useState<AskResult | null>(null);
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [waitingCount, setWaitingCount] = useState('');

  const loadSplit = useCallback((next: SplitCategory) => {
    chrome.runtime.sendMessage({ type: 'LIST_SPLIT', category: next }, (res?: { threads?: SplitThread[] }) => {
      setThreads(res?.threads || []);
    });
  }, []);

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (res?: { settings?: ExtensionSettings }) => {
      if (res?.settings) setSettings({ ...DEFAULT_SETTINGS, ...res.settings });
    });
    // Cloud intelligence (approvals, Focus Queue, Ask Pigeon) only exists in Cloud mode with Google connected.
    chrome.runtime.sendMessage({ type: 'CLOUD_INTEL_STATE' }, (state?: { available?: boolean }) => {
      setCloudAvailable(Boolean(state?.available));
      if (state?.available) {
        chrome.runtime.sendMessage({ type: 'CLOUD_CALL', route: 'approvals', body: { status: 'pending', limit: 1 } }, (res?: { ok?: boolean; data?: { pending?: number } }) => {
          if (res?.ok) setApprovalCount(res.data?.pending ?? 0);
        });
      }
    });
    chrome.runtime.sendMessage({ type: 'RUN_DIAGNOSTICS' }, (diag?: { coverage?: string }) => {
      if (diag?.coverage) setCoverage(diag.coverage);
    });
    chrome.storage.session.get('panelState', (stored) => {
      const state = stored.panelState as { mode?: 'inbox' | 'ask' | 'cloud'; splitCategory?: SplitCategory } | undefined;
      if (state?.mode) setMode(state.mode);
      if (state?.splitCategory) {
        setCategory(state.splitCategory);
        loadSplit(state.splitCategory);
      } else loadSplit('RESPOND');
    });
    const onChanged = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area !== 'session') return;
      if (changes.panelState?.newValue) {
        const state = changes.panelState.newValue as { mode?: 'inbox' | 'ask' | 'cloud'; splitCategory?: SplitCategory };
        if (state.mode) setMode(state.mode);
        if (state.splitCategory) {
          setCategory(state.splitCategory);
          loadSplit(state.splitCategory);
        }
      }
      if (changes.intelPulse) loadSplit(category);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [category, loadSplit]);

  function choose(next: SplitCategory) {
    setCategory(next);
    setMode('inbox');
    chrome.storage.session.set({ panelState: { mode: 'inbox', splitCategory: next } });
    loadSplit(next);
  }

  function ask() {
    const question = query.trim();
    if (!question || loading) return;
    setAsked(question);
    setQuery('');
    setResult(null);
    setDraftState(null);
    setLoading(true);
    chrome.runtime.sendMessage({ type: 'ASK_INBOX', query: question }, (res: AskResult) => {
      setResult(res || { error: 'No response' });
      setLoading(false);
      if (res?.draft) openDraft(res.draft);
    });
  }

  function openDraft(draft: AskDraft) {
    setDraftState('opening');
    chrome.runtime.sendMessage({ type: 'OPEN_COMPOSE_DRAFT', draft }, (res?: { opened?: boolean }) => {
      setDraftState(res?.opened ? 'opened' : 'failed');
    });
  }

  const label = CATEGORIES.find((item) => item[0] === category)?.[1] || 'Inbox';

  return (
    <div className="gi-app flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
      <header className="px-4 pb-3 pt-4">
        <div className="flex items-center justify-between gap-3">
          <Brand />
          <div className="gi-segbar shrink-0">
            <Tab active={mode === 'inbox'} onClick={() => setMode('inbox')}>
              Inbox
            </Tab>
            {cloudAvailable ? (
              <Tab active={mode === 'cloud'} onClick={() => setMode('cloud')}>
                {approvalCount ? `Cloud · ${approvalCount}` : 'Cloud'}
              </Tab>
            ) : null}
            <Tab
              active={mode === 'ask'}
              onClick={() => {
                setMode('ask');
                chrome.storage.session.set({ panelState: { mode: 'ask', splitCategory: category } });
              }}
            >
              Ask
            </Tab>
          </div>
        </div>
        <div className="gi-panel-heading"><div><div className="gi-kicker">{mode === 'ask' ? 'A second pair of eyes' : mode === 'cloud' ? 'Working while you’re away' : 'A little focus goes a long way'}</div><h1>{mode === 'ask' ? 'Ask your inbox' : mode === 'cloud' ? 'PigeonBox Cloud' : label}</h1></div><Pigeon state={loading ? 'indexing' : result?.error ? 'error' : 'idle'} size={78} /></div>
        {mode === 'cloud' ? (
          <p className="gi-muted mt-1 text-[12px]">{approvalCount ? `${approvalCount} waiting for your approval` : 'Nothing waiting for approval'}</p>
        ) : mode === 'inbox' ? (
          <p className="gi-muted mt-1 text-[12px]">{category === 'WAITING' && waitingCount ? waitingCount : threads.length === 1 ? '1 thread' : `${threads.length} threads`}</p>
        ) : (
          <p className="gi-muted mt-1 text-[12px]">Mail already on this computer</p>
        )}
      </header>
      {mode === 'cloud' ? (
        <CloudView onOpenThread={(id) => void openThread(id)} onApprovalCount={setApprovalCount} />
      ) : mode === 'inbox' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <nav className="gi-rail" aria-label="Splits">
            {CATEGORIES.map(([id, name]) => (
              <button key={id} type="button" className="gi-chip-btn" aria-pressed={id === category} data-active={id === category} onClick={() => choose(id)}>
                {name}
              </button>
            ))}
          </nav>
          <main className="min-h-0 flex-1 overflow-auto">
            {category === 'WAITING' ? (
              <WaitingView threads={threads} onOpenThread={(id, folder) => void openThread(id, folder)} onCount={setWaitingCount} />
            ) : threads.length === 0 ? (
              <div className="gi-empty"><Pigeon size={138} /><h2>A quiet little corner.</h2><p>No threads in this view yet.<br />Open Gmail to bring your mail into view.</p></div>
            ) : (
              <ul className="gi-list">
                {threads.map((thread) => (
                  <li key={thread.threadId}>
                    <button type="button" className="gi-mail" onClick={() => openThread(thread.threadId)}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="truncate text-[13px] font-semibold tracking-[-0.02em]">{thread.sender}</span>
                        <span className="gi-time shrink-0">{relative(thread.timestamp)}</span>
                      </div>
                      <div className="mt-0.5 truncate text-[13px] text-[#e7e2d7]">{thread.subject || '(no subject)'}</div>
                      {thread.snippet ? <div className="gi-muted mt-0.5 truncate text-[12px]">{thread.snippet}</div> : null}
                      {thread.manual || thread.priority === 'HIGH' ? (
                        <div className="mt-1.5 flex gap-1.5">
                          {thread.manual ? <span className="gi-mini">Set by you</span> : null}
                          {thread.priority === 'HIGH' ? <span className="gi-mini is-hot">Priority</span> : null}
                        </div>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </main>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-auto px-4 pb-2">
            {result?.coverageNote || coverage ? <p className="gi-muted mb-3 text-[12px] leading-relaxed">{result?.coverageNote || coverage}</p> : null}
            {settings.aiMode === 'disabled' ? <p className="gi-muted mb-3 text-[12px]">AI is off. Results are local matches.</p> : null}
            {result?.error ? <p className="gi-danger">{result.error}</p> : null}
            {asked && (loading || result) ? <p className="gi-asked">{asked}</p> : null}
            {result?.answer ? <p className="whitespace-pre-wrap text-[14px] leading-relaxed tracking-[-0.011em]">{result.answer}</p> : null}
            {result?.draft ? <DraftCard draft={result.draft} state={draftState} onOpen={() => openDraft(result.draft!)} /> : null}
            {!result && !loading ? <div className="gi-ask-start"><h2>What’s on your mind?</h2><p>Find a detail, catch up on a conversation, or remember what you promised.</p><div className="gi-suggestions">{['What needs a reply?', 'What did I promise this week?', 'Find upcoming deadlines'].map((prompt) => <button type="button" key={prompt} onClick={() => setQuery(prompt)}>{prompt}<span aria-hidden="true">↗</span></button>)}</div></div> : null}
            {loading ? <p className="gi-muted gi-orb-line" role="status"><Orb size={20} />Looking through your mail…</p> : null}
            {result?.items?.length ? (
              <ul className="gi-list -mx-4 mt-3">
                {result.items.map((item, index) => (
                  <li key={`${item.threadId || item.subject}-${index}`}>
                    <button
                      type="button"
                      className="gi-mail"
                      disabled={!item.threadId}
                      onClick={() => item.threadId && void openThread(item.threadId, item.who.startsWith('to ') ? 'sent' : 'inbox')}
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="truncate text-[13px] font-semibold tracking-[-0.02em]">{item.who}</span>
                        <span className="gi-time shrink-0" title={item.timestamp ? stamp(item.timestamp) : undefined}>{item.timestamp ? relative(item.timestamp) : ''}</span>
                      </div>
                      <div className="mt-0.5 truncate text-[13px] text-[#e7e2d7]">{item.subject}</div>
                      {item.status ? (
                        <div className="mt-1.5 text-[11px]">
                          <span className="gi-open-state" data-opened={Boolean(item.opened)}><i aria-hidden="true" />{item.status}</span>
                        </div>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : result?.citations?.length ? (
              <ul className="mt-4 space-y-2">
                {result.citations.map((citation) => (
                  <li key={citation.threadId}>
                    <button type="button" className="gi-link text-[13px]" onClick={() => openThread(citation.threadId)}>
                      {citation.subject || citation.threadId}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <form
            className="gi-composer"
            onSubmit={(event) => {
              event.preventDefault();
              ask();
            }}
          >
            <input
              className="gi-field min-w-0 flex-1"
              aria-label="Ask about mail on this computer"
              placeholder="Ask, or draft an email…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button type="submit" className="gi-btn shrink-0" disabled={loading || !query.trim()}>
              {loading ? <><Orb size={14} tone="on-accent" />Working</> : 'Send'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

function DraftCard(props: { draft: AskDraft; state: 'opening' | 'opened' | 'failed' | null; onOpen: () => void }) {
  const { draft, state } = props;
  const to = draft.to.map((contact) => contact.name || contact.email).join(', ');
  const status = state === 'opening' ? 'Opening in Gmail…' : state === 'opened' ? 'Opened in Gmail as a draft. Nothing sends until you do.' : state === 'failed' ? 'Could not open Gmail.' : '';
  return (
    <div className="gi-draft">
      <dl>
        <div><dt>To</dt><dd title={draft.to.map((contact) => contact.email).join(', ')}>{to || <span className="gi-muted">Add a recipient in Gmail</span>}</dd></div>
        <div><dt>Subject</dt><dd>{draft.subject || <span className="gi-muted">(no subject)</span>}</dd></div>
      </dl>
      <p className="gi-draft-body">{draft.body}</p>
      <div className="gi-draft-foot">
        <span className="gi-muted" role="status">{status}</span>
        <button type="button" className="gi-btn gi-btn-ghost" disabled={state === 'opening'} onClick={props.onOpen}>
          {state === 'opened' ? 'Open again' : 'Open in Gmail'}
        </button>
      </div>
    </div>
  );
}

function Tab(props: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button type="button" className="gi-seg" aria-pressed={props.active} data-active={props.active} onClick={props.onClick}>
      {props.children}
    </button>
  );
}

/** Gmail URLs want the hex thread id; InboxSDK sometimes reports the decimal "thread-f:" form. */
function gmailUrlId(threadId: string): string {
  const bare = threadId.trim().replace(/^#/, '').replace(/^(thread-f:|thread-a:|msg-f:|msg-a:)/i, '');
  if (/^\d{17,}$/.test(bare)) {
    try {
      return BigInt(bare).toString(16);
    } catch {
      return bare;
    }
  }
  return bare;
}

async function openThread(threadId: string, folder: 'inbox' | 'sent' = 'inbox'): Promise<void> {
  const url = `https://mail.google.com/mail/u/0/#${folder}/${encodeURIComponent(gmailUrlId(threadId))}`;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id && tab.url?.includes('mail.google.com')) {
    await chrome.tabs.update(tab.id, { url });
    return;
  }
  const gmail = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
  const foreground = gmail.find((item) => item.active && !item.pinned) || gmail.find((item) => !item.pinned);
  if (foreground?.id) await chrome.tabs.update(foreground.id, { url, active: true });
  else await chrome.tabs.create({ url });
}

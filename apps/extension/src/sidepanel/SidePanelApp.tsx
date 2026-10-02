import { trackProductEvent } from '../ui/analytics';
import { Brand, Pigeon } from '../ui/Pigeon';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExtensionSettings } from '@pigeonbox/shared';
import { DEFAULT_SETTINGS } from '@pigeonbox/shared';
import { Orb } from '../ui/Orb';
import { relative, stamp, WaitingView } from './WaitingView';
import { CloudView } from './CloudView';
import { CloudAsk } from './CloudAsk';
import { CloudPreview } from './CloudPreview';
import { useProductState } from '../ui/product-state';
import { DispatchThreads } from '../ui/DispatchThreads';
import { useDispatchLayout } from '../ui/dispatch-motion';
import { CommandLauncher, CommandPalette, type PopupCommand } from '../popup/PopupComponents';
import { availableCloudFeatures } from '../ui/cloud-features';
import '../popup/popup.css';

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

type StoredPanelState = {
  mode?: 'inbox' | 'ask' | 'cloud';
  splitCategory?: SplitCategory;
  askQuery?: string;
  askRequestId?: string;
  cloudSection?: string;
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
  const [palette, setPalette] = useState(false);
  const [mode, setMode] = useState<'inbox' | 'ask' | 'cloud'>('inbox');
  const product = useProductState();
  const cloudMode = product.state.runMode === 'cloud';
  const [cloudSection, setCloudSection] = useState('overview');
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
  const [pendingAsk, setPendingAsk] = useState<{ id: string; query: string } | null>(null);
  const consumedAskId = useRef<string | null>(null);
  const categoryRail = useDispatchLayout<HTMLElement>(category);

  const splitRequest = useRef(0);
  const loadSplit = useCallback((next: SplitCategory) => {
    const request = ++splitRequest.current;
    chrome.runtime.sendMessage({ type: 'LIST_SPLIT', category: next }, (res?: { threads?: SplitThread[] }) => {
      if (request === splitRequest.current) setThreads(res?.threads || []);
    });
  }, []);

  const runAsk = useCallback((question: string) => {
    trackProductEvent('ask_pigeon_used', { surface: 'sidepanel', mode: 'local' });
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
  }, []);

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (res?: { settings?: ExtensionSettings }) => {
      if (res?.settings) setSettings({ ...DEFAULT_SETTINGS, ...res.settings });
    });
    chrome.runtime.sendMessage({ type: 'RUN_DIAGNOSTICS' }, (diag?: { coverage?: string }) => {
      if (diag?.coverage) setCoverage(diag.coverage);
    });
    const applyPanelState = (value: unknown) => {
      const state = value as StoredPanelState | undefined;
      if (state?.mode) setMode(state.mode);
      if (state?.cloudSection) setCloudSection(state.cloudSection);
      if (state?.splitCategory) {
        setCategory(state.splitCategory);
        loadSplit(state.splitCategory);
      } else loadSplit('RESPOND');
      if (state?.askQuery && state.askRequestId && consumedAskId.current !== state.askRequestId) {
        consumedAskId.current = state.askRequestId;
        setPendingAsk({ id: state.askRequestId, query: state.askQuery });
        const cleanState = { ...state };
        delete cleanState.askQuery;
        delete cleanState.askRequestId;
        void chrome.storage.session.set({ panelState: cleanState });
      }
    };
    chrome.storage.session.get('panelState', (stored) => applyPanelState(stored.panelState));
    const onChanged = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area !== 'session') return;
      if (changes.panelState?.newValue) applyPanelState(changes.panelState.newValue);
      if (changes.intelPulse) loadSplit(category);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [category, loadSplit]);

  useEffect(() => {
    if (mode !== 'ask' || !pendingAsk || cloudMode) return;
    setPendingAsk(null);
    runAsk(pendingAsk.query);
  }, [mode, pendingAsk, runAsk, cloudMode]);

  useEffect(() => {
    if (!cloudMode) return;
    void chrome.storage.session.get('panelState').then((stored) => { if (!stored.panelState?.mode) setMode('cloud'); });
  }, [cloudMode]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
      if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]')) return;
      event.preventDefault();
      trackProductEvent('command_palette_opened', { surface: 'sidepanel', mode: cloudMode ? 'cloud' : 'local' });
      setPalette(true);
    };
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, [cloudMode]);
  function navigate(next: 'inbox' | 'ask' | 'cloud', section = 'overview') {
    setMode(next); setCloudSection(section);
    void chrome.storage.session.set({ panelState: { mode: next, splitCategory: category, cloudSection: section } });
  }
  const commands: PopupCommand[] = [
    { id: 'inbox', label: 'Inbox insights', detail: 'Mail indexed on this computer', icon: 'inbox', run: () => navigate('inbox') },
    { id: 'ask', label: 'Ask Pigeon', detail: cloudMode ? 'Available synced Cloud context' : 'Mail on this computer', icon: 'sparkles', run: () => navigate('ask') },
    { id: 'settings', label: 'Settings', detail: 'Execution mode, privacy and preferences', icon: 'settings', run: () => chrome.runtime.openOptionsPage() },
    ...(cloudMode ? [
      { id: 'overview', label: 'Cloud overview', detail: 'Prepared work and sync coverage', icon: 'inbox' as const, run: () => navigate('cloud') },
      ...(product.has('cloud_mail_sync') ? [
        { id: 'approvals', label: 'Open approvals', detail: 'Review actions before they happen', icon: 'edit' as const, run: () => navigate('cloud', 'approvals') },
        { id: 'activity', label: 'Open activity', detail: 'Waiting, signals and recorded actions', icon: 'tracking' as const, run: () => navigate('cloud', 'activity') },
      ] : []),
      ...availableCloudFeatures(product.state.capabilities).map((feature) => ({ id: feature.id, label: `Open ${feature.title}`, detail: feature.detail, icon: 'document' as const, run: () => navigate('cloud', feature.id) })),
    ] : []),
  ];

  function choose(next: SplitCategory) {
    setCategory(next);
    setMode('inbox');
    chrome.storage.session.set({ panelState: { mode: 'inbox', splitCategory: next } });
    loadSplit(next);
  }

  function ask() {
    const question = query.trim();
    if (!question || loading) return;
    runAsk(question);
  }

  function openDraft(draft: AskDraft) {
    setDraftState('opening');
    chrome.runtime.sendMessage({ type: 'OPEN_COMPOSE_DRAFT', draft }, (res?: { opened?: boolean }) => {
      setDraftState(res?.opened ? 'opened' : 'failed');
    });
  }

  const label = CATEGORIES.find((item) => item[0] === category)?.[1] || 'Inbox';

  return (
    <div className="gi-app pb-panel flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden" data-command-open={palette}>
      <header className="pb-panel-header">
        <div className="pb-panel-identity"><Brand /><span className="pb-mode-label">● {cloudMode ? 'Cloud' : 'Local'}</span></div>
        <div className="pb-command-anchor"><CommandLauncher open={palette} onOpen={() => setPalette(true)} />
          {palette ? <CommandPalette inline commands={commands} cloud={cloudMode} onClose={() => setPalette(false)} onAskQuery={(question) => { navigate('ask'); setPendingAsk({ id: crypto.randomUUID(), query: question }); }} /> : null}
        </div>
        <nav className="pb-panel-nav" aria-label="Workspace">
          <Tab active={mode === 'inbox'} onClick={() => navigate('inbox')}>Inbox</Tab>
          <Tab active={mode === 'ask'} onClick={() => navigate('ask')}>Ask</Tab>
          <Tab active={mode === 'cloud'} onClick={() => navigate('cloud')}>{approvalCount ? `Cloud · ${approvalCount}` : 'Cloud'}</Tab>
        </nav>
        <div className="pb-panel-title"><div><div className="gi-kicker">{mode === 'ask' ? 'MAIL INTELLIGENCE' : mode === 'cloud' ? 'ALWAYS-ON DISPATCH' : 'LOCAL INDEX / INBOX'}</div><h1>{mode === 'ask' ? 'Ask Pigeon' : mode === 'cloud' ? 'PigeonBox Cloud' : label}</h1><p>{mode === 'cloud' ? approvalCount ? `${approvalCount} awaiting approval` : 'Prepared work, follow-ups and briefings' : mode === 'inbox' ? category === 'WAITING' && waitingCount ? waitingCount : `${threads.length} threads` : cloudMode ? 'Available synced Cloud context' : 'Mail indexed on this computer'}</p></div><Pigeon state={loading ? 'searching' : draftState === 'opening' ? 'drafting' : result?.error ? 'attention' : draftState === 'opened' ? 'success' : 'idle'} size={54} /></div>
      </header>
      <div className="pb-panel-content" inert={palette}>
      {mode === 'cloud' ? (
        <CloudView key={product.state.cloudOrigins.join('|')} initialSection={cloudSection} onOpenThread={(id, accountId) => void openThread(id, 'inbox', accountId)} onApprovalCount={setApprovalCount} />
      ) : mode === 'inbox' ? (
        <div className="pb-inbox flex min-h-0 flex-1 flex-col">
          <nav ref={categoryRail} className="gi-rail" aria-label="Splits">
            {CATEGORIES.map(([id, name]) => (
              <button key={id} type="button" className="gi-chip-btn" aria-pressed={id === category} data-active={id === category} onClick={() => choose(id)}>
                {id === category ? <span className="pb-category-indicator" data-motion-id="category-indicator" aria-hidden="true" /> : null}{name}
              </button>
            ))}
          </nav>
          <main className="min-h-0 flex-1 overflow-auto">
            {category === 'WAITING' ? (
              <WaitingView threads={threads} onOpenThread={(id, folder) => void openThread(id, folder)} onCount={setWaitingCount} />
            ) : threads.length === 0 ? (
              <div className="gi-empty"><Pigeon size={72} state="offline" /><h2>A quiet little corner.</h2><p>No threads in this view yet.<br />Open Gmail to bring your mail into view.</p></div>
            ) : (
              <DispatchThreads threads={threads} category={category} onOpen={(id) => void openThread(id)} onAsk={(question) => { navigate('ask'); setPendingAsk({ id: crypto.randomUUID(), query: question }); }} />
            )}
            {!cloudMode ? <CloudPreview product={product} compact /> : null}
          </main>
        </div>
      ) : cloudMode ? (product.has('cloud_semantic_search') ? <CloudAsk key={product.state.cloudOrigins.join('|')} pendingQuery={pendingAsk} onQueryConsumed={() => setPendingAsk(null)} capabilities={product.state.capabilities} onOpenThread={(id, accountId) => void openThread(id, 'inbox', accountId)} /> : <div className="px-4"><p className="gi-warn">Cloud Ask is unavailable for this connection. Sign in or check your capabilities in Settings.</p><button type="button" className="gi-btn gi-btn-ghost" onClick={() => chrome.runtime.openOptionsPage()}>Open Settings</button></div>) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-auto px-4 pb-2">
            {result?.coverageNote || coverage ? <p className="gi-muted mb-3 text-[12px] leading-relaxed">{result?.coverageNote || coverage}</p> : null}
            {settings.aiMode === 'disabled' ? <p className="gi-muted mb-3 text-[12px]">AI is off. Results are local matches.</p> : null}
            {result?.error ? <p className="gi-danger">{result.error}</p> : null}
            {asked && (loading || result) ? <p className="gi-asked">{asked}</p> : null}
            {result?.answer ? <section className="pb-answer"><h2 className="gi-kicker">Answer</h2><p className="pb-intelligence whitespace-pre-wrap">{result.answer}</p></section> : null}
            {result?.draft ? <DraftCard draft={result.draft} state={draftState} onOpen={() => openDraft(result.draft!)} /> : null}
            {!result && !loading ? <div className="gi-ask-start"><h2>What’s on your mind?</h2><p>Find a detail, catch up on a conversation, or remember what you promised.</p><div className="gi-suggestions">{['What needs a reply?', 'What did I promise this week?', 'Find upcoming deadlines'].map((prompt) => <button type="button" key={prompt} onClick={() => setQuery(prompt)}>{prompt}<span aria-hidden="true">↗</span></button>)}</div></div> : null}
            {loading ? <p className="gi-muted gi-orb-line" role="status"><Orb size={20} />Looking through your mail…</p> : null}
            {result?.items?.length ? (
              <><h2 className="gi-kicker pb-source-heading">Sources</h2><ul className="gi-list -mx-4 mt-3">
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
              </ul></>
            ) : result?.citations?.length ? (
              <><h2 className="gi-kicker pb-source-heading">Sources</h2><ul className="mt-4 space-y-2">
                {result.citations.map((citation) => (
                  <li key={citation.threadId}>
                    <button type="button" className="gi-link text-[13px]" onClick={() => openThread(citation.threadId)}>
                      {citation.subject || citation.threadId}
                    </button>
                  </li>
                ))}
              </ul></>
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
      )}</div>
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

async function openThread(threadId: string, folder: 'inbox' | 'sent' = 'inbox', accountId?: string): Promise<void> {
  let mailbox = '0';
  if (accountId) {
    const { callCloud } = await import('./cloud-api');
    const result = await callCloud('connections');
    const email = result.ok ? result.data.accounts.find((account) => account.id === accountId)?.email : null;
    if (!email) return;
    mailbox = email;
  }
  const url = accountId ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailbox)}#all/${encodeURIComponent(gmailUrlId(threadId))}` : `https://mail.google.com/mail/u/0/#${folder}/${encodeURIComponent(gmailUrlId(threadId))}`;
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

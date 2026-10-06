import { trackProductEvent } from '../ui/analytics';
import { Brand, Pigeon } from '../ui/Pigeon';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExtensionSettings } from '@pigeonbox/shared';
import { DEFAULT_SETTINGS } from '@pigeonbox/shared';
import { useDispatchLayout } from '../ui/dispatch-motion';
import { useAppearance } from '../ui/appearance';
import { Button, ContextCard, IconButton, Input } from '../ui/Primitives';
import { openSettings } from '../ui/settings-link';
import { Orb } from '../ui/Orb';
import { relative, stamp, WaitingView } from '../sidepanel/WaitingView';
import { CloudView } from '../sidepanel/CloudView';
import { CloudAsk } from '../sidepanel/CloudAsk';
import { useProductState } from '../ui/product-state';
import { DispatchThreads } from '../ui/DispatchThreads';
import { CommandLauncher, CommandPalette, WorkspaceIcon, type WorkspaceCommand } from './Commands';
import { availableCloudFeatures } from '../ui/cloud-features';
import './workspace.css';
import { CurrentThread } from './CurrentThread';
import { useWorkspaceContext, useWorkspaceMailbox } from './context';
import { Tasks } from './Tasks';
import { requestWorkspaceDisplay } from './display';
import { answerThreadQuestion } from './thread-question';
import { useWorkspaceInput } from './session';

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
  mode?: 'home' | 'inbox' | 'ask' | 'cloud';
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

export function PigeonBoxWorkspace() {
  const [active, setActive] = useState<boolean | null>(null);
  useEffect(() => {
    const apply = (value: { display?: string } | undefined) => setActive(!value?.display || (value.display === 'dock') === location.pathname.includes('sidepanel'));
    void chrome.storage.local.get('workspaceState').then((stored) => apply(stored.workspaceState));
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => { if (area === 'local' && changes.workspaceState) apply(changes.workspaceState.newValue); };
    chrome.storage.onChanged.addListener(changed);
    return () => chrome.storage.onChanged.removeListener(changed);
  }, []);
  return active === null ? <div className="pb-panel-header"><Brand /></div> : active ? <WorkspaceContent /> : null;
}
function WorkspaceContent() {
  const [palette, setPalette] = useState(false);
  const [mode, setMode] = useState<'home' | 'inbox' | 'ask' | 'cloud'>('home');
  const product = useProductState();
  const theme = useAppearance();
  const cloudMode = product.state.runMode === 'cloud';
  const [cloudSection, setCloudSection] = useState('overview');
  const [, setApprovalCount] = useState(0);
  const [category, setCategory] = useState<SplitCategory>('RESPOND');
  const [threads, setThreads] = useState<SplitThread[]>([]);
  const [coverage, setCoverage] = useState('');
  const [query, setQuery] = useWorkspaceInput('local:ask', '');
  const [displayError, setDisplayError] = useState('');
  const [asked, setAsked] = useState('');
  const [loading, setLoading] = useState(false);
  const [draftState, setDraftState] = useState<'opening' | 'opened' | 'failed' | null>(null);
  const [result, setResult] = useState<AskResult | null>(null);
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [, setWaitingCount] = useState('');
  const [pendingAsk, setPendingAsk] = useState<{ id: string; query: string } | null>(null);
  const consumedAskId = useRef<string | null>(null);
  const context = useWorkspaceContext();
  const mailbox = useWorkspaceMailbox();
  useEffect(() => { if (window.parent !== window) window.parent.postMessage({ type:'PB_VISUAL_STATE', state:loading ? 'thinking' : context?.drafting ? 'drafting' : result?.draft ? 'ready' : 'idle' }, '*'); }, [loading, context?.drafting, result?.draft]);
  const navigation = useRef({ mode: 'home', category: 'RESPOND', section: 'overview' });

  const splitRequest = useRef(0);
  const loadSplit = useCallback((next: SplitCategory) => {
    const request = ++splitRequest.current;
    chrome.runtime.sendMessage({ type: 'LIST_SPLIT', category: next }, (res?: { threads?: SplitThread[] }) => {
      if (request === splitRequest.current) setThreads(res?.threads || []);
    });
  }, []);

  const runAsk = useCallback(async (question: string) => {
    trackProductEvent('ask_pigeon_used', { surface: 'sidepanel', mode: 'local' });
    setAsked(question);
    setQuery('');
    setResult(null);
    setDraftState(null);
    setLoading(true);
    const action = await answerThreadQuestion(question, context, cloudMode && product.has('cloud_mail_sync'));
    if (action) { setResult({ answer: action, citations: context ? [{ threadId: context.threadId, subject: context.subject }] : [] }); setLoading(false); return; }
    chrome.runtime.sendMessage({ type: 'ASK_INBOX', query: question, threadId: context?.threadId, owner: context?.owner }, (res: AskResult) => {
      setResult(res || { error: 'No response' });
      setLoading(false);

    });
  }, [context, setQuery, cloudMode, product]);

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
      const nextMode = state?.mode === 'cloud' ? 'home' : state?.mode || 'home';
      const nextCategory = state?.splitCategory || 'RESPOND';
      setMode(nextMode);
      setCategory(nextCategory);
      setCloudSection(state?.cloudSection || 'overview');
      if (navigation.current.mode !== nextMode || navigation.current.category !== nextCategory) loadSplit(nextMode === 'home' ? 'RESPOND' : nextCategory);
      navigation.current = { mode: nextMode, category: nextCategory, section: state?.cloudSection || 'overview' };
      if (state?.askQuery && state.askRequestId && consumedAskId.current !== state.askRequestId) {
        consumedAskId.current = state.askRequestId;
        setPendingAsk({ id: state.askRequestId, query: state.askQuery });
        const cleanState = { ...state };
        delete cleanState.askQuery;
        delete cleanState.askRequestId;
        void chrome.storage.session.set({ panelState: cleanState });
      }
    };
    loadSplit('RESPOND');
    // The Gmail shortcut may arrive before this React surface has mounted.
    const consumeCommands = () => void chrome.runtime.sendMessage({ type: 'CONSUME_WORKSPACE_COMMANDS' }).then((value) => { if (value?.open) setPalette(true); });
    consumeCommands();
    chrome.storage.local.get('workspaceState', (stored) => { if (stored.workspaceState) applyPanelState(stored.workspaceState); else chrome.storage.session.get('panelState', (legacy) => applyPanelState(legacy.panelState)); });
    const onChanged = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === 'local' && changes.workspaceState?.newValue) applyPanelState(changes.workspaceState.newValue);
      if (area !== 'session') return;
      if (changes.panelState?.newValue) applyPanelState(changes.panelState.newValue);
      if (changes.intelPulse) loadSplit(navigation.current.mode === 'home' ? 'RESPOND' : navigation.current.category as SplitCategory);
      if (changes.workspaceCommandsRequest?.newValue) consumeCommands();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [loadSplit]);

  useEffect(() => {
    if (mode !== 'ask' || !pendingAsk || cloudMode) return;
    setPendingAsk(null);
    runAsk(pendingAsk.query);
  }, [mode, pendingAsk, runAsk, cloudMode]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !palette && !location.pathname.includes('sidepanel')) {
        event.preventDefault(); void chrome.runtime.sendMessage({ type: 'WORKSPACE_PRESENTATION', patch: { open: false } }); return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
      if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]')) return;
      event.preventDefault();
      trackProductEvent('command_palette_opened', { surface: 'sidepanel', mode: cloudMode ? 'cloud' : 'local' });
      setPalette(true);
    };
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, [cloudMode, palette]);
  function navigate(next: 'home' | 'inbox' | 'ask' | 'cloud', section = 'overview') {
    const destination = next === 'cloud' ? 'home' : next;
    setMode(destination); setCloudSection(section);
    void chrome.runtime.sendMessage({ type: 'WORKSPACE_NAVIGATE', mode: destination, splitCategory: category, cloudSection: section });
  }
  const commands: WorkspaceCommand[] = [
    { id: 'home', label: 'Home', detail: 'Current conversation and work that needs you', icon: 'inbox', run: () => navigate('home') },
    { id: 'inbox', label: 'Inbox insights', detail: 'Mail indexed on this computer', icon: 'inbox', run: () => navigate('inbox') },
    { id: 'ask', label: 'Ask Pigeon', detail: cloudMode ? 'Your synced mailbox' : 'Mail on this computer', icon: 'sparkles', run: () => navigate('ask') },
    ...(context ? [
      { id: 'summarize', label: 'Summarize this thread', detail: context.subject, icon: 'document' as const, run: () => chrome.runtime.sendMessage({ type: 'WORKSPACE_THREAD_ACTION', id: 'summarize', threadId: context.threadId }) },
      { id: 'draft-reply', label: 'Draft a reply', detail: context.subject, icon: 'edit' as const, run: () => chrome.runtime.sendMessage({ type: 'WORKSPACE_THREAD_ACTION', id: 'draft', threadId: context.threadId }) },
      ...(['remind', 'archive', 'mark_respond', 'mark_waiting', 'mark_fyi'] as const).map((id) => ({ id, label: ({ remind: 'Remind me', archive: 'Archive thread', mark_respond: 'Mark Respond', mark_waiting: 'Mark Waiting', mark_fyi: 'Mark FYI' })[id], detail: context.subject, icon: 'inbox' as const, run: () => chrome.runtime.sendMessage({ type: 'WORKSPACE_THREAD_ACTION', id, threadId: context.threadId }) })),
    ] : []),
    { id: 'tracking', label: 'Tracking activity', detail: 'Sent mail and follow-ups', icon: 'tracking', run: () => choose('WAITING') },
    { id: 'settings', label: 'Settings', detail: 'Execution mode, privacy and preferences', icon: 'settings', run: () => openSettings('command_palette', cloudMode ? 'cloud' : 'local') },
    ...(['light', 'dark', 'system'] as const).filter((value) => value !== theme.appearance).map((value) => ({ id: `appearance-${value}`, label: value === 'system' ? 'Match system appearance' : `Switch to ${value} appearance`, detail: `Appearance is ${theme.appearance} now`, icon: 'settings' as const, run: () => theme.change(value) })),
    ...(cloudMode ? [
      ...(product.has('cloud_auto_drafts') ? [
        { id: 'drafts', label: 'Prepared drafts', detail: 'Replies ready to review or already in Gmail', icon: 'edit' as const, run: () => navigate('cloud', 'drafts') },
      ] : []),
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
    void chrome.runtime.sendMessage({ type: 'WORKSPACE_NAVIGATE', mode: 'inbox', splitCategory: next });
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

  

  return (
    <div className="gi-app pb-panel flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden" data-embedded={window.parent !== window} data-command-open={palette} data-view={mode}>
      <header className="pb-panel-header">
        <div className="pb-panel-identity"><Brand state={context?.drafting ? 'drafting' : context?.pending ? 'indexing' : loading ? 'working' : 'idle'} /><span className="pb-mode-label">{cloudMode ? 'Cloud' : 'Local'}</span></div>
        <div className="pb-command-anchor"><CommandLauncher open={palette} onOpen={() => setPalette(true)} />
          {palette ? <CommandPalette inline commands={commands} cloud={cloudMode} onClose={() => setPalette(false)} onAskQuery={(question) => { navigate('ask'); setPendingAsk({ id: crypto.randomUUID(), query: question }); }} /> : null}
        </div>
        <div className="pb-workspace-navigation"><nav className="pb-panel-nav" aria-label="Workspace">
          {/* Gmail is already the inbox: Inbox insights live in the command palette and Home's links, not in the chrome. */}
          <Tab active={mode !== 'ask'} onClick={() => navigate('home')}>Home</Tab>
          <Tab active={mode === 'ask'} onClick={() => navigate('ask')}>Ask</Tab>
        </nav><div className="pb-window-controls"><IconButton label="Open PigeonBox Settings" data-settings-entry onClick={() => openSettings('workspace_header', cloudMode ? 'cloud' : 'local')}><WorkspaceIcon name="settings" size={16} /></IconButton><button type="button" className="pb-icon-btn" aria-label={location.pathname.includes('sidepanel') ? 'Float in Gmail' : 'Dock to side'} title={location.pathname.includes('sidepanel') ? 'Float in Gmail' : 'Dock to side'} onClick={() => { setDisplayError(''); void requestWorkspaceDisplay(location.pathname.includes('sidepanel') ? 'float' : 'dock').catch(() => setDisplayError('Could not move the workspace. Try again.')); }}><WorkspaceIcon name="dock" size={16} /></button></div></div>
      </header>
      {displayError ? <p className="gi-warn px-4" role="alert">{displayError}</p> : null}
      <div className="pb-panel-content" inert={palette}>
      {mode === 'home' ? (
        <div className="pb-home-content min-h-0 flex-1 overflow-auto"><CurrentThread key={`${context?.threadId}:${JSON.stringify(context?.owner)}`} context={context} onAsk={(question) => { navigate('ask'); setPendingAsk({ id: crypto.randomUUID(), query: question }); }} />{!context ? <Tasks key={product.state.cloud.email} context={null} enabled={cloudMode && product.has('cloud_mail_sync')} /> : null}
        {cloudMode ? (
        <CloudView key={`${product.state.cloudOrigins.join('|')}:${product.state.cloud.email}`} initialSection={cloudSection} onSectionChange={(section) => { setCloudSection(section); void chrome.runtime.sendMessage({ type: 'WORKSPACE_NAVIGATE', mode: 'home', cloudSection: section }); }} onOpenThread={(id, accountId) => void openThread(id, 'inbox', accountId)} onApprovalCount={setApprovalCount} />
        ) : <section className="pb-local-home"><h2 className="gi-kicker">Needs your reply</h2>{threads.length ? <DispatchThreads threads={threads.slice(0, 8)} category="RESPOND" onOpen={(id) => void openThread(id)} onAsk={(question) => { navigate('ask'); setPendingAsk({ id: crypto.randomUUID(), query: question }); }} /> : <p className="gi-muted">You’re caught up.</p>}<button type="button" className="gi-text-btn" onClick={() => choose('WAITING')}>Waiting &amp; follow-ups →</button></section>}
        </div>
      ) : mode === 'inbox' ? (
        <div className="pb-inbox flex min-h-0 flex-1 flex-col">
          <label className="pb-inbox-select"><span>Inbox</span><select aria-label="Inbox category" value={category} onChange={(event) => choose(event.target.value as SplitCategory)}>{CATEGORIES.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>{threads.length ? <span className="pb-meta">{threads.length}</span> : null}</label>
          <main className="min-h-0 flex-1 overflow-auto">
            {category === 'WAITING' ? (
              <WaitingView threads={threads} onOpenThread={(id, folder) => void openThread(id, folder)} onCount={setWaitingCount} />
            ) : threads.length === 0 ? (
              <div className="gi-empty"><Pigeon size={32} state="idle" /><h2>Nothing needs you here.</h2><p>No threads in this view yet.</p></div>
            ) : (
              <DispatchThreads threads={threads} category={category} onOpen={(id) => void openThread(id)} onAsk={(question) => { navigate('ask'); setPendingAsk({ id: crypto.randomUUID(), query: question }); }} />
            )}
          </main>
        </div>
      ) : cloudMode ? (product.has('cloud_semantic_search') ? <CloudAsk key={`${product.state.cloudOrigins.join('|')}:${product.state.cloud.email}`} context={context} mailbox={mailbox?.email} pendingQuery={pendingAsk} onQueryConsumed={() => setPendingAsk(null)} capabilities={product.state.capabilities} onContextQuestion={(question) => answerThreadQuestion(question, context, product.has('cloud_mail_sync'))} onOpenThread={(id, accountId) => void openThread(id, 'inbox', accountId)} /> : <div className="px-4"><p className="gi-warn">Cloud Ask is unavailable for this connection. Sign in or check your plan on the dashboard.</p><button type="button" className="gi-btn gi-btn-ghost" onClick={() => void chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD', section: 'cloud', setup: 'cloud' })}>Open dashboard</button></div>) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="pb-ask-content min-h-0 flex-1 overflow-auto">
            {context ? <ContextCard subject={context.subject} sender={context.sender} motionKey={`context:${context.threadId}`} /> : null}
            {result?.coverageNote || coverage ? <p className="gi-muted mb-3 text-[12px] leading-relaxed">{result?.coverageNote || coverage}</p> : null}
            {settings.aiMode === 'disabled' ? <p className="gi-muted mb-3 text-[12px]">AI is off. Results are local matches.</p> : null}
            {result?.error ? <p className="gi-danger">{result.error}</p> : null}
            {asked && (loading || result) ? <p className="gi-asked">{asked}</p> : null}
            {result?.answer ? <section className="pb-answer"><h2 className="gi-kicker">Answer</h2><p className="pb-intelligence whitespace-pre-wrap">{result.answer}</p></section> : null}
            {result?.draft ? <DraftCard draft={result.draft} state={draftState} onOpen={openDraft} /> : null}
            {!result && !loading ? <div className="gi-ask-start"><h2>What’s on your mind?</h2><p>{context ? `This thread · ${context.subject || 'Current conversation'}` : 'Mail indexed on this computer'}</p><div className="gi-suggestions">{(context ? ['Summarize this', 'What do I need to do?', 'Did they open this?'] : ['What needs a reply?', 'What did I promise this week?', 'Find upcoming deadlines']).map((prompt) => <button type="button" key={prompt} onClick={() => setQuery(prompt)}>{prompt}<span aria-hidden="true">↗</span></button>)}</div></div> : null}
            {loading ? <p className="gi-muted gi-orb-line" role="status"><Orb size={20} state="searching" />Looking through your mail…</p> : null}
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
                      <div className="mt-0.5 truncate text-[13px] text-[color:var(--pb-fg)]">{item.subject}</div>
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
            <Input
              className="min-w-0 flex-1"
              aria-label="Ask about mail on this computer"
              placeholder="Ask, or draft an email…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button type="submit" className="shrink-0" disabled={loading || !query.trim()}>
              {loading ? <><Orb size={14} tone="on-accent" />Working</> : 'Send'}
            </Button>
          </form>
        </div>
      )}</div>
    </div>
  );
}

function DraftCard(props: { draft: AskDraft; state: 'opening' | 'opened' | 'failed' | null; onOpen: (draft: AskDraft) => void }) {
  const { draft, state } = props;
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(draft.body);
  const layout = useDispatchLayout<HTMLDivElement>(editing);
  useEffect(() => { setBody(draft.body); setEditing(false); }, [draft]);
  const to = draft.to.map((contact) => contact.name || contact.email).join(', ');
  const status = state === 'opening' ? 'Opening in Gmail…' : state === 'opened' ? 'Opened in Gmail as a draft. Nothing sends until you do.' : state === 'failed' ? 'Could not open Gmail.' : '';
  return (
    <div ref={layout} className="gi-draft" data-editing={editing}>
      <dl>
        <div><dt>To</dt><dd title={draft.to.map((contact) => contact.email).join(', ')}>{to || <span className="gi-muted">Add a recipient in Gmail</span>}</dd></div>
        <div><dt>Subject</dt><dd>{draft.subject || <span className="gi-muted">(no subject)</span>}</dd></div>
      </dl>
      <div className="pb-local-draft-content" data-motion-id="prepared-local-reply">{editing ? <><label className="pb-editor-label" htmlFor="pb-local-draft-body">Reply prepared · edit draft</label><textarea autoFocus id="pb-local-draft-body" className="gi-field pb-editor" value={body} rows={Math.max(6, Math.min(12, body.split('\n').length + 1))} onChange={(event) => setBody(event.target.value)} /></> : <p className="gi-draft-body">{body}</p>}</div>
      <div className="gi-draft-foot">
        <span className="gi-muted" role="status">{status || 'Reply prepared'}</span>{!editing ? <button type="button" className="gi-text-btn" onClick={() => setEditing(true)}>Edit draft</button> : null}
        <button type="button" className="gi-btn gi-btn-ghost" disabled={state === 'opening'} onClick={() => props.onOpen({ ...draft, body })}>
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

export async function openThread(threadId: string, folder: 'inbox' | 'sent' = 'inbox', accountId?: string): Promise<void> {
  let mailbox = '0';
  if (accountId) {
    const { callCloud } = await import('../sidepanel/cloud-api');
    const result = await callCloud('connections');
    const email = result.ok ? result.data.accounts.find((account) => account.id === accountId)?.email : null;
    if (!email) return;
    mailbox = email;
  }
  let url = accountId ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailbox)}#all/${encodeURIComponent(gmailUrlId(threadId))}` : `https://mail.google.com/mail/u/0/#${folder}/${encodeURIComponent(gmailUrlId(threadId))}`;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id && tab.url?.startsWith('https://mail.google.com/')) {
    if (!accountId) { const current = new URL(tab.url); current.hash = `${folder}/${encodeURIComponent(gmailUrlId(threadId))}`; url = current.href; }
    await chrome.tabs.update(tab.id, { url });
    return;
  }
  const gmail = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
  const foreground = gmail.find((item) => item.active && !item.pinned) || gmail.find((item) => !item.pinned);
  if (foreground?.id) {
    if (!accountId && foreground.url) { const current = new URL(foreground.url); current.hash = `${folder}/${encodeURIComponent(gmailUrlId(threadId))}`; url = current.href; }
    await chrome.tabs.update(foreground.id, { url, active: true });
  }
  else await chrome.tabs.create({ url });
}

import { analyzeHeuristically, detectMeetingRequest } from '../intel/heuristics.js';
import { compileView } from '../intel/rule-compiler.js';
import { readDataBlock, type AnalysisInput, type DraftPromptInput, type ResearchInput } from '../intel/prompts.js';

/**
 * Mock answers for the server-side operations. Deterministic and offline,
 * for development and tests. It deliberately behaves like an imperfect model:
 * asked about prices or meeting times it has no source for, it states some
 * anyway, so the grounding guard's placeholders can be tested end to end.
 */
export function mockServerAnswer(operation: string, prompt: string): string {
  const data = readDataBlock(prompt);
  if ((data as { task?: string } | null)?.task === 'commitment_reconcile') return JSON.stringify({ resolutions: [] });
  if ((data as { task?: string } | null)?.task === 'memory_chat') return JSON.stringify(mockMemoryChat(prompt, data as Parameters<typeof mockMemoryChat>[1]));
  switch (operation) {
    case 'memory_extract':
      return JSON.stringify({ memories: [] });
    case 'memory_consolidate':
      return JSON.stringify(prompt.includes('"pages"') ? { pages: [] } : { facts: [] });
    case 'compose_check':
      // Like a careful model: nothing to say unless a test's fixture backend says otherwise.
      return JSON.stringify({ surface: false, kind: 'context', message: '', confidence: 0, sourceIds: [], suggestedText: null });
    case 'thread_analysis':
      return JSON.stringify(mockAnalysis(data as AnalysisInput));
    case 'grounded_draft':
      return JSON.stringify(mockDraft(data as DraftPromptInput));
    case 'research':
      return JSON.stringify(mockResearch(data as ResearchInput));
    case 'snippet': {
      const sources = (data as { sources?: Array<{ text: string }> } | null)?.sources ?? [];
      const first = sources.find((source) => source.text.trim())?.text.split(/(?<=[.?!])\s/)[0];
      return JSON.stringify(first ? { text: first.slice(0, 200), unresolved: false } : { text: '[DETAIL NEEDED]', unresolved: true });
    }
    default: {
      // View and automation operations share prompts; tell them apart by shape.
      const request = prompt.match(/^Request: (".*")$/m)?.[1];
      if (request) return JSON.stringify(mockViewCompile(JSON.parse(request) as string));
      const criteria = prompt.match(/Criteria: (".*")/)?.[1];
      const words = criteria ? (JSON.parse(criteria) as string).toLowerCase().match(/[a-z]{5,}/g) ?? [] : [];
      const judge = (value: unknown) => {
        const block = JSON.stringify(value ?? {}).toLowerCase();
        const hit = words.some((word) => block.includes(word));
        return { matches: hit, confidence: hit ? 0.8 : 0.7, reason: hit ? 'Mentions the topic' : 'Different topic' };
      };
      if (/"results"/.test(prompt)) {
        const threads = (data as { threads?: Array<{ id: string }> } | null)?.threads ?? [];
        return JSON.stringify({ results: threads.map((thread) => ({ id: thread.id, ...judge(thread) })) });
      }
      if (/"matches"/.test(prompt)) return JSON.stringify(judge(data));
      return '{}';
    }
  }
}

const MOCK_NOT_A_NAME = /^(professors?|teachers?|faculty|people|someone|anyone|my|the|a|an|me|them|us|school|work|recruiters?)$/i;

/** A capable compiler: the deterministic one, plus names after "from" handed back as people to resolve. */
function mockViewCompile(text: string) {
  const view = compileView(text);
  const names = [...text.matchAll(/\bfrom\s+([a-z][a-z'-]+)(?!\S*@)/gi)].map((match) => match[1]!).filter((name) => !MOCK_NOT_A_NAME.test(name) && !view.filter.from.include.includes(name.toLowerCase()));
  const judgment = /\b(important|urgent|interesting|relevant|actually|really|worth|serious|personal)\b/i.test(text);
  const filter = view.filter;
  return {
    name: view.name,
    fromPeople: [...filter.from.include, ...names],
    notFromPeople: filter.from.exclude,
    toPeople: filter.to.include,
    states: filter.states,
    labels: filter.labels.include,
    subjectAny: filter.subjectAny,
    keywordsAny: filter.keywordsAny,
    direction: filter.direction,
    deadlineWithinDays: filter.deadlineWithinDays,
    noReplyForBusinessDays: filter.noReplyForBusinessDays,
    relationship: filter.relationship,
    engagement: filter.engagement,
    readByUser: filter.readByUser,
    receivedWithinDays: filter.receivedWithinDays,
    hasAttachment: filter.hasAttachment,
    aiCriteria: judgment ? text : null,
    actions: view.actions.map((action) => ({ kind: action.kind, label: typeof action.params.label === 'string' ? action.params.label : null, businessDays: typeof action.params.businessDays === 'number' ? action.params.businessDays : null })),
    confidence: view.confidence,
  };
}

function mockAnalysis(input: AnalysisInput | null) {
  if (!input) return {};
  const analysis = analyzeHeuristically(
    {
      subject: input.subject,
      labels: input.labels,
      ownerEmails: input.ownerEmails,
      timeZone: input.timeZone,
      messages: input.messages.map((message) => ({ ...message, fromName: message.fromName })),
    },
    new Date(input.now),
  );
  // A model is a little more confident than the rules.
  return { ...analysis, confidence: Math.min(0.95, analysis.confidence + 0.2) };
}

function mockDraft(input: DraftPromptInput | null) {
  if (!input) return {};
  const lastInbound = [...input.thread].reverse().find((message) => message.direction === 'inbound');
  // Greet by first name when the recipient's name is known (never from a role address like hiring@).
  const recipient = input.recipients[0];
  const firstName = recipient?.name?.replace(/^(?:dr|prof|mr|mrs|ms)\.?\s+/i, '').split(/\s+/)[0] ?? '';
  const greeting = (input.style.greeting ?? 'Hi {first},').replace('{first}', firstName || 'there');
  const signoff = `${input.style.signoff ?? 'Thanks'},\n${input.owner.name || input.owner.email.split('@')[0]}`;
  const text = lastInbound?.text ?? '';
  const lines: string[] = [];
  const used: string[] = [];
  const asked = (input.instructions ?? '').toLowerCase();
  if (/\bthank/.test(asked)) {
    lines.push('Thank you, I really appreciate it.');
  } else if (/\bdecline|say no|turn (?:it|this) down/.test(asked)) {
    lines.push("Thank you for thinking of me. I can't take this on right now.");
  } else if (input.kind === 'follow_up') {
    lines.push('Just following up on my note below. Let me know when you have a chance.');
  } else if (input.kind === 'scheduling' || detectMeetingRequest(text).isScheduling) {
    const slots = input.sources.filter((source) => source.kind === 'calendar_event' || /availability/i.test(source.title));
    if (slots.length) {
      lines.push(`Happy to find a time. I'm free ${slots[0]!.text}.`);
      used.push(slots[0]!.id);
    } else {
      // Ungrounded on purpose: the grounding guard must turn this into a placeholder.
      lines.push('Happy to meet. How about Tuesday, October 6 at 3pm?');
    }
  } else if (/\b(price|pricing|cost|quote|rate)\b/i.test(text)) {
    lines.push('Thanks for asking. The price for the package is $4,500 per year.');
  } else if (/\baddress\b/i.test(text)) {
    lines.push('Sure, the address is 221 Market Street, Suite 400.');
  } else {
    // A well-behaved model answers each request, marking what it cannot know.
    const asks = answerRequests(text);
    lines.push(...(asks.length ? asks : ["Thanks for the note. I'll take a look and get back to you soon."]));
  }
  if (input.sources[0]) used.push(input.sources[0].id);
  const body = `${greeting}\n\n${lines.join('\n\n')}\n\n${signoff}`;
  const variants: Array<{ label: string; strategy: string; body: string; usedSources: string[] }> = [{ label: 'recommended', strategy: 'Direct answer', body, usedSources: [...new Set(used)] }];
  if (input.allowVariants && /\b(invite|invitation|would you like|are you interested|join us)\b/i.test(text)) {
    variants.push({
      label: 'alternative',
      strategy: 'Politely decline',
      body: `${greeting}\n\nThank you for thinking of me. I can't take this on right now, but I'd love to stay in touch.\n\n${signoff}`,
      usedSources: [],
    });
    variants.push({ label: 'shorter', strategy: 'Brief yes', body: `${greeting}\n\nCount me in.\n\n${signoff}`, usedSources: [] });
    variants.push({ label: 'shorter', strategy: 'Duplicate that should be dropped', body: `${greeting}\n\nCount me in!\n\n${signoff}`, usedSources: [] });
  }
  return { variants: variants.slice(0, 4), missingFacts: [], confidence: 0.7 };
}

/** One line per recognizable request, with placeholders for facts the thread does not contain. */
function answerRequests(text: string): string[] {
  const lines: string[] = [];
  const thing = text.match(/\b(?:send|share|attach|forward)\b[^.?!]{0,40}?\b(resume|cv|deck|slides|report|document|file|form|contract|invoice)\b/i)?.[1];
  if (thing) lines.push(`I'll send the ${thing.toLowerCase()} over: [ATTACHMENT NEEDED]`);
  if (/\b(?:which|what) (?:weeks?|days?|dates?)\b|\bwhen (?:can|could) you (?:start|begin)\b|\bavailable to start\b/i.test(text)) lines.push("I'm available to start [DATE NEEDED].");
  if (/\bwhen (?:it|this|that) will be (?:fixed|resolved|ready|done)\b|\b(?:eta|timeline)\b|\bwhen (?:will|can) (?:it|this|you)\b/i.test(text)) {
    lines.push("Thanks for flagging this. We're looking into it now and expect to have an update by [DATE NEEDED].");
  }
  if (/\b(?:questions?|comments?)\b/i.test(text) && !lines.length) lines.push('Thank you, I will review your comments and follow up with any questions.');
  return lines;
}

function mockResearch(input: ResearchInput | null) {
  if (!input) return {};
  if (!input.sources.length) {
    return { answer: 'I could not find anything about that in your synced mail or calendar.', claims: [], unverified: [], complete: false };
  }
  const top = input.sources.slice(0, 3);
  const claims = top.map((source) => ({ text: `${source.title}${source.who ? ` (${source.who})` : ''}: ${source.text.split(/(?<=[.?!])\s/)[0]!.slice(0, 160)}`, sources: [source.id] }));
  return {
    answer: claims.map((claim) => claim.text).join('\n'),
    claims,
    unverified: [],
    complete: input.sources.length <= 3,
  };
}

// ---------------------------------------------------------------------------
// Ask Pigeon agent. A stand-in for a tool-using model: round one searches
// (plus the record tools the wording points at), round two reads the best
// thread, then it answers from what the tools returned, citing labels.
// ---------------------------------------------------------------------------

const MOCK_STOP = new Set(
  'what who whom when where which how did do does i me my am are is was were the a an to for of on in with about have has had any all from that this these those there their them they you your we our us before after by it its be been will would should could can please tell give find show he she his her him said say says recently lately latest last week today yesterday tomorrow anything something someone everyone up new'.split(' '),
);

type MockToolCall = { id: string; name: string; arguments: string };
type MockMessage = { role: string; content: string; toolCalls?: MockToolCall[] };

export function mockAgentStep(request: { messages: MockMessage[]; tools?: Array<{ name: string }>; toolChoice?: 'auto' | 'none' }): { text: string; toolCalls: MockToolCall[] } {
  const available = new Set((request.tools ?? []).map((tool) => tool.name));
  const messages = request.messages;
  let lastUser = -1;
  messages.forEach((message, index) => {
    if (message.role === 'user' && !message.content.startsWith('Time is up')) lastUser = index;
  });
  const question = (messages[lastUser]?.content ?? '').replace(/^\[Now: [^\]]*\]\n/, '').split('\n\n(The user has')[0]!;
  const lower = question.toLowerCase();
  const after = messages.slice(lastUser + 1);
  const called = after.flatMap((message) => message.toolCalls?.map((call) => call.name) ?? []);
  const results = after.filter((message) => message.role === 'tool').map((message) => safeJson(message.content));
  const calls: MockToolCall[] = [];
  const call = (name: string, args: Record<string, unknown>) => {
    if (available.has(name)) calls.push({ id: `mock_${after.length}_${calls.length}`, name, arguments: JSON.stringify(args) });
  };
  const keyword = (lower.match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? []).find((word) => !MOCK_STOP.has(word));
  const current = messages[lastUser]?.content.match(/The user has this email open: (S\d+)/)?.[1];

  if (request.toolChoice !== 'none') {
    if (!called.length) {
      if (/waiting on|owes? me a reply|no reply/.test(lower)) call('list_waiting_on', {});
      if (/promis|commit|\bowe\b/.test(lower)) call('list_commitments', { direction: /\b(did|have) i\b|\bi (promised|owe)/.test(lower) ? 'mine' : 'both' });
      if (/\bfree\b|availab|find (a )?time/.test(lower)) call('find_free_time', { duration_minutes: Number(lower.match(/(\d{1,3})[\s-]?min/)?.[1] ?? 30) });
      if (/deadline|\bdue\b/.test(lower)) call('list_deadlines', {});
      if (/opened|clicked/.test(lower)) call('email_tracking', {});
      if (current) call('read_thread', { source: current });
      if (!calls.length && keyword) {
        call('search_mail', { query: keyword });
        call('search_index', { query: question });
      }
      if (calls.length) return { text: '', toolCalls: calls };
    } else if (!called.includes('read_thread')) {
      const label = results.flatMap((result) => (Array.isArray(result?.results) ? result.results : [])).find((item: { source?: string; subject?: string }) => item?.source && item.subject !== undefined)?.source as string | undefined;
      if (label) {
        call('read_thread', { source: label });
        if (/\bdraft\b/.test(lower)) call('draft_reply', { source: label, kind: 'reply', instructions: question });
        return { text: '', toolCalls: calls };
      }
    }
  }

  const lines: string[] = [];
  for (const result of results) {
    if (!result || typeof result !== 'object') continue;
    if (Array.isArray(result.messages) && result.source) {
      const latest = result.messages[result.messages.length - 1] as { from?: string; text?: string } | undefined;
      if (latest) lines.push(`- ${latest.from} wrote in "${result.subject}": ${String(latest.text ?? '').slice(0, 160)} [${result.source}]`);
    } else if (Array.isArray(result.slots) && result.source) {
      for (const slot of result.slots) lines.push(`- Free ${slot} [${result.source}]`);
    }
    for (const item of Array.isArray(result.results) ? result.results : []) {
      const describe = item.promise ? `${item.who === 'user' ? 'You promised' : 'They promised'}: ${item.promise} (${item.thread})` : item.subject ?? item.title ?? item.summary ?? item.name ?? item.text;
      if (item.source && describe) lines.push(`- ${String(describe).slice(0, 200)} [${item.source}]`);
    }
  }
  const unique = [...new Set(lines)].slice(0, 8);
  if (unique.length) return { text: `Here is what I found:\n${unique.join('\n')}`, toolCalls: [] };
  return { text: keyword ? `I searched your mail for "${keyword}" but couldn't find anything about that.` : 'Happy to help. What would you like to know about your mail?', toolCalls: [] };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Deliberately simple offline fixture, never the production reasoning path. */
function mockMemoryChat(prompt: string, data: { memories: Array<{ref:string;text:string;category:string}>; page: {type:string;key:string;label:string} | null }) {
  const request = JSON.parse(prompt.match(/Current owner request: (.*)\n/)?.[1] ?? '""') as string;
  const match = request.match(/^(Remember|Update|Forget)[:\s]+([\s\S]*)$/i);
  const common = { answer: data.memories.slice(0,4).map((memory) => memory.text).join(' ') || 'I do not have a saved fact about that yet.', intent: 'ask', references: data.memories.slice(0,4).map((memory) => memory.ref), changes: [] as unknown[] };
  if (!match) return common;
  const kind = match[1]!.toLowerCase() === 'remember' ? 'save' : match[1]!.toLowerCase();
  return { ...common, intent:'change', changes: [{kind,ref:kind === 'save' ? null : data.memories[0]?.ref ?? null,text:kind === 'forget' ? null : match[2], evidence:request,subject:kind === 'save' ? /^I\b/i.test(match[2]!) ? {type:'self',key:'self',label:'You'} : data.page ?? {type:'self',key:'self',label:'You'} : null,category:'preferences',memoryKind:'preference',entities:[{type:'topic',key:'writing preferences'}]}] };
}

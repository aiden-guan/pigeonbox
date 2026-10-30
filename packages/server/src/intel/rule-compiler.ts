import { FilterSpecSchema, type ActionSpec, type FilterSpec } from '@pigeonbox/api-contract';
import type { ThreadState } from '@pigeonbox/shared';
import type { ViewCompileOutput } from './prompts.js';

/**
 * Natural language → explainable filter.
 *
 * `compileViewWithAi` (rules.ts) is the main path: one structured model call reads the
 * request the way a person would ("from allen h", "stuff about my lease"),
 * names resolve to addresses against the user's contacts, and the result is
 * the same exact, explainable filter. It prefers exact criteria, because an AI
 * criterion costs a model call per thread every time the view runs.
 *
 * `compileView` is the deterministic compiler, used when AI is unavailable or
 * over budget: senders, domains, states, deadlines, reply timing, engagement,
 * attachments and well-known topics become exact criteria. Only judgment words
 * ("important", "actually", "interesting") or unrecognized topics add an AI
 * criterion, and the explanation says so.
 */

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fourteen: 14, thirty: 30 };

const TOPICS: Array<{ pattern: RegExp; keywords: string[]; label: string }> = [
  { pattern: /\brecruit\w*|\bhiring\b|\bjob\b|\binterview\w*/i, keywords: ['recruiter', 'recruiting', 'hiring', 'interview', 'candidate', 'position', 'role', 'offer'], label: 'recruiting' },
  { pattern: /\bintern(ship)?s?\b/i, keywords: ['internship', 'intern'], label: 'internships' },
  { pattern: /\breceipts?\b|\binvoices?\b|\bconfirmations?\b|\borders?\b/i, keywords: ['receipt', 'invoice', 'order', 'confirmation', 'payment', 'purchase'], label: 'receipts and confirmations' },
  { pattern: /\btravel\b|\bflights?\b|\bhotels?\b|\bbooking\w*/i, keywords: ['flight', 'hotel', 'booking', 'itinerary', 'reservation', 'boarding'], label: 'travel' },
  { pattern: /\bprofessors?\b|\bclass(es)?\b|\bcourses?\b|\bassignments?\b|\bsyllabus\b/i, keywords: ['professor', 'course', 'class', 'assignment', 'syllabus', 'lecture', 'office hours'], label: 'school' },
  { pattern: /\bpricing\b|\bquotes?\b|\bproposals?\b|\bcontracts?\b|\bsales\b/i, keywords: ['pricing', 'quote', 'proposal', 'contract', 'renewal', 'order form'], label: 'sales' },
  { pattern: /\bsupport\b|\btickets?\b|\bbugs?\b|\bissues?\b/i, keywords: ['support', 'ticket', 'bug', 'issue', 'outage', 'error'], label: 'support' },
  { pattern: /\blegal\b|\bnda\b|\bagreements?\b/i, keywords: ['legal', 'nda', 'agreement', 'terms', 'signature'], label: 'legal' },
];

const JUDGMENT = /\b(important|urgent|interesting|relevant|actually|really|worth|serious|real|personal|meaningful|valuable)\b/i;

export type CompiledView = {
  name: string;
  filter: FilterSpec;
  explanation: string[];
  usesAi: boolean;
  actions: ActionSpec[];
  warnings: string[];
  confidence: number;
};

function number(text: string): number | null {
  const digit = text.match(/\b(\d{1,3})\b/);
  if (digit) return Number(digit[1]);
  const word = Object.keys(NUMBER_WORDS).find((key) => new RegExp(`\\b${key}\\b`, 'i').test(text));
  return word ? NUMBER_WORDS[word]! : null;
}

function titleCase(text: string): string {
  const words = text.replace(/[^\w\s@.'-]/g, '').trim().split(/\s+/).slice(0, 5);
  return words.map((word, index) => (index === 0 ? word[0]!.toUpperCase() + word.slice(1) : word)).join(' ').slice(0, 120) || 'Smart View';
}

export function compileView(prompt: string, contacts: Array<{ email: string; name: string | null }> = []): CompiledView {
  const text = prompt.trim();
  const lower = text.toLowerCase();
  const spec = FilterSpecSchema.parse({});
  const explanation: string[] = [];
  const warnings: string[] = [];
  const states = new Set<ThreadState>();
  const actions: ActionSpec[] = [];
  let recognized = 0;

  // Senders: emails, domains, and names of people you know.
  for (const match of text.matchAll(/\b(?:not from|except(?: from)?|excluding)\s+([\w.+-]+@[\w.-]+\.\w+|@?[\w-]+(?:\.[\w-]+)+)/gi)) {
    spec.from.exclude.push(match[1]!.toLowerCase());
    explanation.push(`Not from ${match[1]}`);
    recognized += 1;
  }
  for (const match of text.matchAll(/\bfrom\s+([\w.+-]+@[\w.-]+\.\w+|@?[\w-]+(?:\.[\w-]+)+)/gi)) {
    const value = match[1]!.toLowerCase();
    if (spec.from.exclude.includes(value)) continue;
    spec.from.include.push(value);
    explanation.push(`From ${value}`);
    recognized += 1;
  }
  const namedFrom = text.match(/\bfrom\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/);
  if (namedFrom && !spec.from.include.length) {
    const wanted = namedFrom[1]!.toLowerCase();
    // By display name, or by the first part of the address (lee.park@… is "Lee") for people known only by email.
    const localName = (email: string) => email.toLowerCase().split('@')[0]!.split(/[._-]/)[0]!;
    const matches = contacts.filter((contact) => (contact.name ?? '').toLowerCase().startsWith(wanted) || (!wanted.includes(' ') && localName(contact.email) === wanted));
    if (matches.length) {
      for (const contact of matches.slice(0, 5)) spec.from.include.push(contact.email.toLowerCase());
      explanation.push(`From ${namedFrom[1]} (${matches.slice(0, 3).map((contact) => contact.email).join(', ')})`);
      recognized += 1;
    } else {
      warnings.push(`PigeonBox does not know anyone named ${namedFrom[1]} yet; that part uses AI judgment.`);
    }
  }
  if (/\bprofessors?\b|\bteachers?\b|\bfaculty\b/i.test(lower)) {
    spec.from.include.push('.edu');
    explanation.push('From a school address (.edu)');
    recognized += 1;
  }

  // Reply state and timing.
  const noReply = lower.match(/(?:not|haven'?t|hasn'?t|didn'?t|no)\s+(?:responded|replied|answered|gotten back)(?:\s+(?:in|for|after|within))?\s+([\w-]+)\s+(business\s+)?days?/);
  if (noReply || /\bwaiting on (them|people|others|replies)\b|\bno reply\b|\bgone cold\b|\bwent cold\b/.test(lower)) {
    spec.direction = 'outbound';
    spec.noReplyForBusinessDays = noReply ? number(noReply[1]!) ?? 3 : 3;
    states.add('WAITING_ON_THEM');
    states.add('FOLLOW_UP_DUE');
    explanation.push(`You wrote last and got no reply for ${spec.noReplyForBusinessDays} business days`);
    recognized += 1;
  }
  if (/\bneeds? (?:my |a )?(?:response|reply|answer)|\bneed(?:s)? to (?:respond|reply)|\bto reply to\b|\bunanswered\b/.test(lower)) {
    states.add('NEEDS_REPLY');
    states.add('WAITING_ON_ME');
    explanation.push('Waiting on your reply');
    recognized += 1;
  }
  if (/\bnewsletters?\b/.test(lower)) {
    states.add('NEWS');
    explanation.push('Newsletters');
    recognized += 1;
  }
  if (/\bpromotions?\b|\bmarketing\b|\bdeals?\b|\bsales emails?\b/.test(lower)) {
    states.add('PROMOTION');
    explanation.push('Promotions');
    recognized += 1;
  }
  if (/\bnotifications?\b|\balerts?\b|\bautomated\b/.test(lower)) {
    states.add('NOTIFICATION');
    explanation.push('Automated notifications');
    recognized += 1;
  }
  if (/\b(i|you) (actually |really )?(read|open)\b|\bthat i read\b/.test(lower)) {
    spec.readByUser = true;
    explanation.push('From senders whose mail you open');
    recognized += 1;
  }

  // Deadlines and recency.
  if (/\bdeadlines?\b|\bdue\b/.test(lower)) {
    spec.deadlineWithinDays = /\btoday\b/.test(lower) ? 1 : /\btomorrow\b/.test(lower) ? 2 : /\bthis month\b/.test(lower) ? 31 : /\bnext week\b/.test(lower) ? 14 : 7;
    explanation.push(`Has a deadline within ${spec.deadlineWithinDays} day${spec.deadlineWithinDays === 1 ? '' : 's'}`);
    recognized += 1;
  } else {
    const recent = lower.match(/\b(?:this|past|last)\s+(week|month|(\w+)\s+days)\b/);
    if (recent) {
      spec.receivedWithinDays = recent[1] === 'week' ? 7 : recent[1] === 'month' ? 31 : number(recent[1]!) ?? 7;
      explanation.push(`Active in the last ${spec.receivedWithinDays} days`);
      recognized += 1;
    }
  }
  if (/\battachments?\b|\battached\b|\bpdfs?\b/.test(lower)) {
    spec.hasAttachment = true;
    explanation.push('Has an attachment');
    recognized += 1;
  }
  if (/\bvips?\b|\bimportant people\b/.test(lower)) {
    spec.relationship = ['vip'];
    explanation.push('From people you marked VIP');
    recognized += 1;
  }
  if (/\bclicked\b/.test(lower)) spec.engagement = 'clicked';
  else if (/\bopened\b/.test(lower) && !spec.readByUser) spec.engagement = 'opened';
  else if (/\bnever opened\b|\bno engagement\b|\bnot opened\b/.test(lower)) spec.engagement = 'no_engagement';
  if (spec.engagement) {
    explanation.push(spec.engagement === 'no_engagement' ? 'No likely recipient activity' : `Recipient ${spec.engagement} it (likely)`);
    recognized += 1;
  }

  // Topics.
  const topics = TOPICS.filter((topic) => topic.pattern.test(lower));
  for (const topic of topics) {
    spec.keywordsAny.push(...topic.keywords);
    explanation.push(`About ${topic.label}`);
    recognized += 1;
  }
  spec.keywordsAny = [...new Set(spec.keywordsAny)].slice(0, 20);
  for (const quoted of text.matchAll(/"([^"]{2,60})"|“([^”]{2,60})”/g)) {
    spec.subjectAny.push((quoted[1] ?? quoted[2])!);
    explanation.push(`Subject mentions “${quoted[1] ?? quoted[2]}”`);
    recognized += 1;
  }

  // Actions the request describes ("…and archive them"). Mailbox changes start in Shadow Mode.
  if (/\barchive\b/.test(lower)) actions.push({ kind: 'archive', params: {} });
  const label = text.match(/\blabel(?:led)?(?: them| it)?(?: as)? ["“]?([\w\s/-]{2,40}?)["”]?(?:$|[,.]| and)/i);
  if (label) actions.push({ kind: 'label', params: { label: label[1]!.trim() } });
  if (/\bmark (?:them |it )?(?:as )?important\b/.test(lower)) actions.push({ kind: 'mark_important', params: {} });
  if (/\bstar\b/.test(lower)) actions.push({ kind: 'star', params: {} });
  if (/\bremind me\b/.test(lower)) actions.push({ kind: 'remind', params: { businessDays: number(lower.match(/remind me (?:in|after) ([\w-]+)/)?.[1] ?? '') ?? 1 } });
  if (/\b(prepare|draft) (?:a )?(?:reply|response)\b/.test(lower)) actions.push({ kind: 'draft_reply', params: {} });

  spec.states = [...states];
  const judgment = JUDGMENT.test(lower);
  const unknownTopic = recognized === 0;
  if (judgment || unknownTopic || (warnings.length > 0 && !spec.from.include.length)) {
    spec.aiCriteria = text.slice(0, 500);
    explanation.push(`AI judgment: “${text.slice(0, 120)}”`);
    warnings.push('Part of this view needs AI judgment, so matches can be wrong. Review them before automating anything.');
  }
  if (actions.length) warnings.push('Views that change your mailbox start in Shadow Mode: PigeonBox shows what it would do until you confirm enough examples.');
  const parsed = FilterSpecSchema.parse(spec);
  return {
    name: titleCase(text),
    filter: parsed,
    explanation: explanation.slice(0, 20).map((line) => line.slice(0, 200)),
    usesAi: Boolean(parsed.aiCriteria),
    actions: actions.slice(0, 8),
    warnings: warnings.slice(0, 8).map((line) => line.slice(0, 200)),
    confidence: parsed.aiCriteria ? (recognized ? 0.6 : 0.4) : Math.min(0.95, 0.7 + recognized * 0.08),
  };
}

/** Plain-language criteria for a stored filter (used when the user edits filters directly). */
export function explainFilter(filter: FilterSpec): string[] {
  const out: string[] = [];
  if (filter.from.include.length) out.push(`From ${filter.from.include.join(', ')}`);
  if (filter.from.exclude.length) out.push(`Not from ${filter.from.exclude.join(', ')}`);
  if (filter.to.include.length) out.push(`To ${filter.to.include.join(', ')}`);
  if (filter.states.length) out.push(`State: ${filter.states.map((state) => state.toLowerCase().replace(/_/g, ' ')).join(', ')}`);
  if (filter.labels.include.length) out.push(`Label: ${filter.labels.include.join(', ')}`);
  if (filter.subjectAny.length) out.push(`Subject mentions ${filter.subjectAny.map((value) => `“${value}”`).join(' or ')}`);
  if (filter.keywordsAny.length) out.push(`Mentions ${filter.keywordsAny.slice(0, 6).join(', ')}${filter.keywordsAny.length > 6 ? '…' : ''}`);
  if (filter.direction !== 'any') out.push(filter.direction === 'outbound' ? 'You wrote last' : 'They wrote last');
  if (filter.deadlineWithinDays !== null) out.push(`Deadline within ${filter.deadlineWithinDays} days`);
  if (filter.noReplyForBusinessDays !== null) out.push(`No reply for ${filter.noReplyForBusinessDays} business days`);
  if (filter.relationship.length) out.push(`Relationship: ${filter.relationship.join(', ')}`);
  if (filter.engagement) out.push(`Engagement: ${filter.engagement.replace('_', ' ')}`);
  if (filter.readByUser) out.push('Senders whose mail you open');
  if (filter.receivedWithinDays !== null) out.push(`Active in the last ${filter.receivedWithinDays} days`);
  if (filter.hasAttachment !== null) out.push(filter.hasAttachment ? 'Has an attachment' : 'No attachment');
  if (filter.aiCriteria) out.push(`AI judgment: “${filter.aiCriteria.slice(0, 120)}”`);
  return out.length ? out : ['Every synced thread'];
}

type Contact = { email: string; name: string | null };

const ADDRESS = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/;
const DOMAIN = /^[@.]?[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}$|^\.[a-z]{2,}$/;

/**
 * People as the user wrote them → filter addresses. Addresses and domains pass
 * through; a name matches contacts whose name or address words start with
 * every word given ("allen h" → Allen Hu), newest contacts first.
 */
export function resolvePeople(people: string[], contacts: Contact[]): { addresses: string[]; lines: string[]; unknown: string[] } {
  const addresses: string[] = [];
  const lines: string[] = [];
  const unknown: string[] = [];
  for (const raw of people) {
    const value = raw.trim().toLowerCase();
    if (!value) continue;
    if (ADDRESS.test(value) || DOMAIN.test(value)) {
      addresses.push(value);
      lines.push(value);
      continue;
    }
    const words = value.split(/[\s.]+/).filter(Boolean);
    const matches = contacts.filter((contact) => {
      const tokens = [...(contact.name ?? '').toLowerCase().split(/[\s,]+/), ...contact.email.toLowerCase().split('@')[0]!.split(/[._+-]/)].filter(Boolean);
      return words.every((word) => tokens.some((token) => token.startsWith(word)));
    });
    if (!matches.length) {
      unknown.push(raw.trim());
      continue;
    }
    for (const contact of matches.slice(0, 5)) addresses.push(contact.email.toLowerCase());
    lines.push(`${raw.trim()} (${matches.slice(0, 3).map((contact) => contact.email).join(', ')}${matches.length > 3 ? '…' : ''})`);
  }
  return { addresses: [...new Set(addresses)].slice(0, 100), lines, unknown };
}

/** The model's reading of a request → a validated, explained view draft. */
export function viewFromAi(prompt: string, output: ViewCompileOutput, contacts: Contact[]): CompiledView {
  const from = resolvePeople(output.fromPeople, contacts);
  const notFrom = resolvePeople(output.notFromPeople, contacts);
  const to = resolvePeople(output.toPeople, contacts);
  const warnings: string[] = [];
  const unknown = [...from.unknown, ...to.unknown];
  for (const name of unknown) warnings.push(`PigeonBox does not know anyone named ${name} yet; that part uses AI judgment.`);
  for (const name of notFrom.unknown) warnings.push(`PigeonBox does not know anyone named ${name}, so they could not be excluded.`);
  const judgment = [output.aiCriteria?.trim(), ...from.unknown.map((name) => `from someone named ${name}`), ...to.unknown.map((name) => `to someone named ${name}`)].filter(Boolean).join('; ');
  const exact = FilterSpecSchema.parse({
    from: { include: from.addresses, exclude: notFrom.addresses },
    to: { include: to.addresses, exclude: [] },
    states: [...new Set(output.states)],
    labels: { include: output.labels, exclude: [] },
    subjectAny: output.subjectAny,
    keywordsAny: [...new Set(output.keywordsAny.map((word) => word.toLowerCase()))],
    direction: output.direction,
    deadlineWithinDays: output.deadlineWithinDays,
    noReplyForBusinessDays: output.noReplyForBusinessDays,
    relationship: [...new Set(output.relationship)],
    engagement: output.engagement,
    readByUser: output.readByUser,
    receivedWithinDays: output.receivedWithinDays,
    hasAttachment: output.hasAttachment,
    aiCriteria: judgment ? judgment.slice(0, 500) : null,
  });
  // A filter with no criteria would match every thread: let judgment decide instead.
  const filter = explainFilter(exact)[0] === 'Every synced thread' ? { ...exact, aiCriteria: prompt.trim().slice(0, 500) } : exact;
  const actions: ActionSpec[] = [];
  for (const action of output.actions) {
    if (action.kind === 'label') {
      if (action.label?.trim()) actions.push({ kind: 'label', params: { label: action.label.trim() } });
    } else if (action.kind === 'remind' || action.kind === 'snooze') actions.push({ kind: action.kind, params: { businessDays: action.businessDays ?? 1 } });
    else actions.push({ kind: action.kind, params: {} });
  }
  if (filter.aiCriteria) warnings.push('Part of this view needs AI judgment, so matches can be wrong. Review them before automating anything.');
  if (actions.length) warnings.push('Views that change your mailbox start in Shadow Mode: PigeonBox shows what it would do until you confirm enough examples.');
  const people = [
    ...(from.lines.length ? [`From ${from.lines.join(', ')}`] : []),
    ...(notFrom.lines.length ? [`Not from ${notFrom.lines.join(', ')}`] : []),
    ...(to.lines.length ? [`To ${to.lines.join(', ')}`] : []),
  ];
  const rest = explainFilter({ ...filter, from: { include: [], exclude: [] }, to: { include: [], exclude: [] } }).filter((line) => line !== 'Every synced thread');
  return {
    name: output.name.trim().slice(0, 120) || titleCase(prompt),
    filter,
    explanation: [...people, ...rest].slice(0, 20).map((line) => line.slice(0, 200)),
    usesAi: Boolean(filter.aiCriteria),
    actions: actions.slice(0, 8),
    warnings: warnings.slice(0, 8).map((line) => line.slice(0, 200)),
    confidence: filter.aiCriteria ? Math.min(output.confidence, 0.7) : output.confidence,
  };
}

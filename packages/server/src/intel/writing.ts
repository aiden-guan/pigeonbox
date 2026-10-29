import type { Preferences } from '@pigeonbox/api-contract';
import { one, type SqlExecutor } from '../db/sql.js';

/**
 * Writing profiles learned from the user's sent mail and from how they edit
 * PigeonBox drafts. Only structure is kept: greeting shape with names replaced
 * ("Hi {first},"), sign-off word, length, sentence length, question, bullet,
 * emoji and exclamation rates, formality and directness. Never message text,
 * so typos and sensitive content cannot be learned or leaked.
 */

export type Structure = {
  greeting: string | null;
  signoff: string | null;
  words: number;
  avgSentenceWords: number;
  questionRate: number;
  bulletRate: number;
  emojiRate: number;
  exclamationRate: number;
  formality: number;
  directness: number;
};

const GREETING = /^(hi|hey|hello|dear|good (?:morning|afternoon|evening)|morning|hiya|greetings|yo|hi there|hello there)\b[\s,!]*(.*)$/i;
const SIGNOFF = /^(best(?: regards| wishes)?|thanks(?: so much| again)?|thank you(?: so much)?|cheers|regards|kind regards|warm regards|warmly|sincerely|talk soon|thx|many thanks|all the best|speak soon|take care)\s*[,!.]?\s*$/i;
const FORMAL = /\b(dear|sincerely|regards|kindly|please find|i would like to|furthermore|therefore|appreciate your|at your earliest convenience)\b/gi;
const CASUAL = /\b(hey|thx|gonna|wanna|cool|awesome|haha|lol|yeah|yep|nope|no worries|cheers)\b/gi;
const HEDGES = /\b(just|maybe|perhaps|i was wondering|i think|sort of|kind of|if possible|if that'?s ok|sorry to bother)\b/gi;
const EMOJI = /\p{Extended_Pictographic}/gu;

function normalizeGreeting(line: string): string | null {
  const match = line.trim().match(GREETING);
  if (!match || line.length > 60) return null;
  const word = match[1]!.replace(/^\w/, (c) => c.toUpperCase());
  const rest = match[2]!.trim();
  const punctuation = /[,!]\s*$/.test(line.trim()) ? line.trim().slice(-1) : ',';
  if (!rest || /^[,!]$/.test(rest)) return `${word}${punctuation}`;
  // Group greetings keep their word; a person's name becomes {first}.
  if (/^(all|team|everyone|folks|both|guys|y'all|there)\b/i.test(rest)) return `${word} ${rest.replace(/[,!]\s*$/, '').toLowerCase()}${punctuation}`;
  return `${word} {first}${punctuation}`;
}

export function analyzeStructure(text: string): Structure {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((line) => line.trim());
  const content = lines.filter(Boolean);
  const greeting = content[0] ? normalizeGreeting(content[0]) : null;
  let signoff: string | null = null;
  for (let i = content.length - 1; i >= Math.max(0, content.length - 4); i -= 1) {
    const match = content[i]!.match(SIGNOFF);
    if (match) {
      signoff = match[1]!.replace(/^\w/, (c) => c.toUpperCase());
      break;
    }
  }
  const body = content.slice(greeting ? 1 : 0).join(' ');
  const words = (body.match(/\b[\w'’-]+\b/g) ?? []).length;
  const sentences = Math.max(1, (body.match(/[.!?]+(\s|$)/g) ?? []).length);
  const formal = (text.match(FORMAL) ?? []).length;
  const casual = (text.match(CASUAL) ?? []).length + (text.match(/\b\w+'(?:ll|re|ve|d|m|s|t)\b/gi) ?? []).length * 0.3;
  const hedges = (text.match(HEDGES) ?? []).length;
  return {
    greeting,
    signoff,
    words,
    avgSentenceWords: words / sentences,
    questionRate: (body.match(/\?/g) ?? []).length / sentences,
    bulletRate: content.filter((line) => /^([-*•]|\d+[.)])\s/.test(line)).length > 0 ? 1 : 0,
    emojiRate: (text.match(EMOJI) ?? []).length > 0 ? 1 : 0,
    exclamationRate: (body.match(/!/g) ?? []).length / sentences,
    formality: Math.max(0, Math.min(1, 0.5 + (formal - casual) * 0.15)),
    directness: Math.max(0, Math.min(1, 0.8 - (hedges / sentences) * 0.4)),
  };
}

const WEBMAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'aol.com']);

/** Exponential moving average that weights recent mail, with a cold-start plain average. */
function blend(current: number | null, next: number, count: number): number {
  if (current === null || count === 0) return next;
  const weight = Math.max(1 / (count + 1), 0.1);
  return current * (1 - weight) + next * weight;
}

async function update(tx: SqlExecutor, userId: string, level: 'global' | 'recipient' | 'domain' | 'email_type', key: string, s: Structure): Promise<void> {
  const current = await one<{
    sample_count: number;
    avg_words: number | null;
    avg_sentence_words: number | null;
    question_rate: number | null;
    bullet_rate: number | null;
    emoji_rate: number | null;
    exclamation_rate: number | null;
    formality: number | null;
    directness: number | null;
  }>(tx, `select * from public.writing_profiles where user_id = $1::uuid and level = $2 and key = $3`, [userId, level, key]);
  const n = current?.sample_count ?? 0;
  await tx.query(
    `insert into public.writing_profiles (user_id, level, key, sample_count, greeting, signoff, avg_words, avg_sentence_words, question_rate, bullet_rate, emoji_rate, exclamation_rate, formality, directness, updated_at)
     values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
     on conflict (user_id, level, key) do update set sample_count = excluded.sample_count,
       greeting = coalesce(excluded.greeting, public.writing_profiles.greeting), signoff = coalesce(excluded.signoff, public.writing_profiles.signoff),
       avg_words = excluded.avg_words, avg_sentence_words = excluded.avg_sentence_words, question_rate = excluded.question_rate,
       bullet_rate = excluded.bullet_rate, emoji_rate = excluded.emoji_rate, exclamation_rate = excluded.exclamation_rate,
       formality = excluded.formality, directness = excluded.directness, updated_at = now()`,
    [
      userId,
      level,
      key,
      Math.min(n + 1, 10_000),
      s.greeting,
      s.signoff,
      blend(current?.avg_words ?? null, s.words, n),
      blend(current?.avg_sentence_words ?? null, s.avgSentenceWords, n),
      blend(current?.question_rate ?? null, s.questionRate, n),
      blend(current?.bullet_rate ?? null, s.bulletRate, n),
      blend(current?.emoji_rate ?? null, s.emojiRate, n),
      blend(current?.exclamation_rate ?? null, s.exclamationRate, n),
      blend(current?.formality ?? null, s.formality, n),
      blend(current?.directness ?? null, s.directness, n),
    ],
  );
}

/** Learn from one message the user sent. The text is read here and not kept. */
export async function learnFromSent(tx: SqlExecutor, userId: string, input: { text: string; to: string[]; emailType: 'reply' | 'new' | 'follow_up' | 'scheduling' }): Promise<void> {
  const text = input.text.trim();
  if (text.length < 20) return;
  const structure = analyzeStructure(text);
  await update(tx, userId, 'global', '', structure);
  await update(tx, userId, 'email_type', input.emailType, structure);
  const recipient = input.to[0]?.toLowerCase();
  if (recipient) {
    await update(tx, userId, 'recipient', recipient, structure);
    const domain = recipient.split('@')[1];
    if (domain && !WEBMAIL.has(domain)) await update(tx, userId, 'domain', domain, structure);
  }
}

/** Learn from the difference between a PigeonBox draft and what the user kept. Only ratios and shapes are stored. */
export async function learnFromEdit(tx: SqlExecutor, userId: string, input: { draft: string; final: string; recipient: string | null }): Promise<void> {
  const draft = analyzeStructure(input.draft);
  const final = analyzeStructure(input.final);
  const shortened = final.words < draft.words * 0.8 ? 1 : 0;
  const levels: Array<['global' | 'recipient', string]> = [['global', '']];
  if (input.recipient) levels.push(['recipient', input.recipient.toLowerCase()]);
  for (const [level, key] of levels) {
    const current = await one<{ sample_count: number; edit_shorten_rate: number | null }>(
      tx,
      `select sample_count, edit_shorten_rate from public.writing_profiles where user_id = $1::uuid and level = $2 and key = $3`,
      [userId, level, key],
    );
    await tx.query(
      `insert into public.writing_profiles (user_id, level, key, sample_count, greeting, signoff, edit_shorten_rate, updated_at)
       values ($1::uuid, $2, $3, 0, $4, $5, $6, now())
       on conflict (user_id, level, key) do update set edit_shorten_rate = excluded.edit_shorten_rate,
         greeting = coalesce(excluded.greeting, public.writing_profiles.greeting), signoff = coalesce(excluded.signoff, public.writing_profiles.signoff), updated_at = now()`,
      [userId, level, key, final.greeting, final.signoff, blend(current?.edit_shorten_rate ?? null, shortened, current?.sample_count ?? 0)],
    );
  }
}

export type ResolvedStyle = {
  level: 'recipient' | 'domain' | 'email_type' | 'global' | 'default';
  greeting: string | null;
  signoff: string | null;
  targetWords: number | null;
  formality: 'casual' | 'neutral' | 'formal';
  bullets: boolean;
  emoji: boolean;
  notes: string[];
};

/** The most specific profile with enough samples, falling back to the extension's voice settings. */
export async function resolveStyle(
  tx: SqlExecutor,
  userId: string,
  input: { recipient: string | null; emailType: 'reply' | 'new' | 'follow_up' | 'scheduling'; voice: Preferences['voice'] },
): Promise<ResolvedStyle> {
  const recipient = input.recipient?.toLowerCase() ?? null;
  const domain = recipient?.split('@')[1] ?? null;
  const rows = await tx.query<{
    level: 'global' | 'recipient' | 'domain' | 'email_type';
    key: string;
    sample_count: number;
    greeting: string | null;
    signoff: string | null;
    avg_words: number | null;
    formality: number | null;
    bullet_rate: number | null;
    emoji_rate: number | null;
    edit_shorten_rate: number | null;
    directness: number | null;
  }>(
    `select level, key, sample_count, greeting, signoff, avg_words, formality, bullet_rate, emoji_rate, edit_shorten_rate, directness
       from public.writing_profiles
      where (level = 'recipient' and key = $1) or (level = 'domain' and key = $2) or (level = 'email_type' and key = $3) or level = 'global'`,
    [recipient ?? '', domain ?? '', input.emailType],
  );
  const order: Array<ResolvedStyle['level']> = ['recipient', 'domain', 'email_type', 'global'];
  const pick = order.map((level) => rows.find((row) => row.level === level && row.sample_count >= (level === 'global' ? 3 : 2))).find(Boolean);
  const global = rows.find((row) => row.level === 'global');
  const voice = input.voice;
  const notes: string[] = [];
  if (voice?.personalInstructions) notes.push(voice.personalInstructions.slice(0, 300));
  if (voice?.about) notes.push(`About the sender: ${voice.about.slice(0, 200)}`);
  if (voice?.schedulingPreference && input.emailType === 'scheduling') notes.push(`Scheduling preference: ${voice.schedulingPreference.slice(0, 200)}`);
  const shorten = (pick?.edit_shorten_rate ?? global?.edit_shorten_rate ?? 0) > 0.5;
  if (shorten) notes.push('The sender usually shortens drafts; keep it tight');
  if ((pick?.directness ?? 0.6) > 0.75) notes.push('Be direct; avoid hedging');
  const avgWords = pick?.avg_words ?? null;
  const formalityScore = pick?.formality ?? null;
  const formality: ResolvedStyle['formality'] =
    formalityScore === null ? voice?.formality ?? 'neutral' : formalityScore > 0.62 ? 'formal' : formalityScore < 0.4 ? 'casual' : 'neutral';
  const voiceGreeting = voice?.greeting ? `${voice.greeting} {first},` : null;
  return {
    level: pick ? pick.level : voice ? 'default' : 'default',
    greeting: pick?.greeting ?? global?.greeting ?? voiceGreeting,
    signoff: pick?.signoff ?? global?.signoff ?? voice?.signoff ?? null,
    targetWords: avgWords ? Math.round(Math.max(25, Math.min(250, avgWords * (shorten ? 0.75 : 1)))) : voice?.concision === 'short' ? 50 : voice?.concision === 'long' ? 160 : null,
    formality,
    bullets: (pick?.bullet_rate ?? 0) > 0.3,
    emoji: (pick?.emoji_rate ?? 0) > 0.3 || Boolean(voice?.emoji),
    notes,
  };
}

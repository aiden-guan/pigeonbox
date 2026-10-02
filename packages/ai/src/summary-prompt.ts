import { splitSuperseded, tagAuthors, type AuthorRole } from '@pigeonbox/shared';
import type { MailboxOwner } from './index.js';

/**
 * Shared instructions for every selected model (ChatGPT, API models, on-device).
 * The model must reason first (Chain-of-Thought) before outputting the structured brief.
 */
export const EMAIL_SUMMARY_SYSTEM_PROMPT = `You are an elite executive intelligence assistant analyzing an email thread. You synthesize what happened, why it matters, and what's next. You do NOT repeat or clip sentences from the email.

Perform step-by-step reasoning first in the "reasoning" field before drafting the summary:
1. Sender & Intent: Who sent this, what is their goal, and what is the situation?
2. Thread Progression: In multi-message threads, trace the chronology. What was initially discussed, what did subsequent replies resolve, and what is the LATEST active status? If earlier questions were already answered in later replies, they are resolved.
3. Signal vs Noise: Separate essential business substance from formalities, greetings, sign-offs, marketing hype ("we're thrilled to announce"), vague filler, and disclaimers.
4. Current vs old: Text above a dashed line, or above "Previous announcement" / "Earlier announcement" / a quoted reply, is the current status. Do not lead with the old notice, and do not describe a replaced plan as if it is still happening.
5. Next Steps: Who has the ball? Is any action or decision needed from the recipient, by what deadline?

Fields to output in valid JSON:
- reasoning: 1 to 3 sentences of clear step-by-step thinking analyzing sender intent, thread progression, latest state, and needed action vs noise.
- oneLine: 1 to 2 crisp, articulate sentences synthesizing the core update (who/what/why) in your own words. Focus on the actual takeaway and impact for the reader. Do not start with greetings or robot formulas. Never exceed 360 characters.
- keyPoints: 0 to 3 high-value factual points that add essential context not already covered in oneLine. [] if oneLine covers everything.
- actionItems: 0 to 3 concrete verb phrases representing real next steps (e.g. "Review staging pull request", "Submit budget approval"). [] if purely informational.
- dates: only a date the reader should remember (a deadline, exam, meeting, or the day something they must do starts). Phrase it, for example "Due Sep 26" or "Week 6 starts Sep 28". Never output a bare number like "9/28", a bare month, or a date that only appears in a superseded notice. [] if every date is history or already happened.
- unansweredQuestions: ONLY questions that remain OPEN and unaddressed in the latest state of the thread and genuinely require a response from the recipient. MUST be [] for newsletters, promotions, automated notifications, or if already answered in a later reply.
- decisions: explicit decisions or consensus reached during the thread. [] if none or if promotional/announcement.
- commitments: explicit commitments made by participants (e.g. "Sarah will patch the bug tomorrow"). [] if none.

Never invent names, dates, or requests. Never quote marketing fluff or copy verbatim sentences.

Example output:
{
  "reasoning": "Sarah is following up on the iOS login bug reported earlier by John. The team reproduced the issue on iOS 17. Sarah committed to releasing a hotfix tomorrow morning, so no immediate debugging action is required from the user.",
  "oneLine": "Sarah confirmed the iOS 17 login bug reported by John and will deploy a hotfix tomorrow morning.",
  "keyPoints": ["Bug is isolated to iOS 17 authentication tokens."],
  "decisions": ["Deploy hotfix directly to production tomorrow morning."],
  "unansweredQuestions": [],
  "commitments": ["Sarah: release hotfix tomorrow morning"],
  "dates": ["Tomorrow morning"],
  "actionItems": []
}`;

export function formatThreadForSummary(input: {
  subject: string;
  messages: Array<{ sender: string; bodyText: string; timestamp?: string; authorRole?: AuthorRole }>;
  includeOlder?: boolean;
  owner?: MailboxOwner;
}): string {
  const messages = tagAuthors(input.messages.filter((m) => m.bodyText.trim().length > 0), input.owner);
  const latestCurrent = splitSuperseded(messages.at(-1)?.bodyText || '').current;
  const subject = input.includeOlder === false ? currentSubject(input.subject, latestCurrent) : input.subject;
  const parts: string[] = [`Subject: ${subject || '(no subject)'}`];
  if (input.owner?.email) {
    const who = input.owner.name ? `${input.owner.name} <${input.owner.email}>` : input.owner.email;
    parts.push(`Reader: ${who}. Messages marked (me) were written by the reader. Write "you" for the reader, never their name.`);
  }
  if (!messages.length) {
    parts.push('\n[No message body content]');
    return parts.join('\n');
  }

  messages.forEach((msg, idx) => {
    const time = msg.timestamp ? ` at ${msg.timestamp}` : '';
    const sender = msg.authorRole === 'owner' ? ' from you (me) [authorRole=owner]' : ` from ${msg.sender || 'someone'} [authorRole=other]`;
    parts.push(`\n--- Message ${idx + 1}${sender}${time} ---`);
    const { current, older } = splitSuperseded(msg.bodyText);
    parts.push(current.trim());
    if (older && input.includeOlder !== false) {
      parts.push(
        '\n[Older notice. This is not the current status unless the latest text above still depends on it.]',
      );
      parts.push(older.trim().slice(0, 1200));
    }
  });

  return parts.join('\n');
}

function currentSubject(subject: string, current: string): string {
  const currentWeeks = new Set([...current.matchAll(/\bweek\s+(\d+)\b/gi)].map((match) => match[1]));
  if (!currentWeeks.size) return subject;
  return subject
    .replace(/\s+(?:for|in|during|of)\s+week\s+(\d+)\b/gi, (match, week: string) => currentWeeks.has(week) ? match : '')
    .replace(/\bweek\s+(\d+)\b/gi, (match, week: string) => currentWeeks.has(week) ? match : '')
    .trim();
}

export function summaryUserContent(formattedThreadOrJson: string): string {
  return `Analyze and synthesize this email thread. Reason first, then provide the brief in JSON.\n\n${formattedThreadOrJson}`;
}

/**
 * Ask Pigeon is a chat box, so people say "hi" and "thanks" to it. Those are
 * answered here, instantly and the same way in Local and Cloud, instead of
 * searching mail and handing a model threads that have nothing to do with it.
 */

const CAPABILITIES =
  'I can search your mail, find threads that still need a reply, show what you sent and who hasn\'t gotten back to you, or draft a new email.';

type Rule = { pattern: RegExp; reply: string };

/** Whole-message patterns only: "hi, did Sam reply?" is a real question and falls through. */
const RULES: Rule[] = [
  {
    pattern: /^(?:(?:hi|hello|hey|heya|hiya|howdy|yo|sup|hola|greetings|good (?:morning|afternoon|evening|day))(?: there| pigeon(?:box)?| again)?|what'?s up|whats good|wassup|wazzup)$/,
    reply: `Hi! How can I help? ${CAPABILITIES}`,
  },
  {
    pattern: /^(?:how(?:'?s| is| are)? (?:it going|you(?: doing)?(?: today)?|things|life)|how do you do|you (?:ok|okay|good|there))$/,
    reply: "Doing well, thanks for asking! What can I help you with in your inbox?",
  },
  {
    pattern: /^(?:(?:thank you|thanks|thank u|thx|ty|tysm|cheers|much appreciated|appreciate it)(?: (?:so much|a lot|very much|again|pigeon))*|(?:great|perfect|awesome|nice|cool) thanks?)$/,
    reply: "You're welcome! Anything else?",
  },
  {
    pattern: /^(?:bye|goodbye|good bye|see (?:ya|you)(?: later)?|later|cya|good ?night|gn|ttyl)$/,
    reply: 'Bye for now!',
  },
  {
    pattern:
      /^(?:help|\?+|(?:what|who) (?:are|r) (?:you|u)|what (?:can|do) (?:you|u) do|what (?:can|should) i (?:ask|say)(?: you)?|how (?:do|does) (?:this|it|you) work|(?:can you |could you )?help(?: me)?|what is (?:this|pigeon(?:box)?)|what are you for)$/,
    reply: `I'm Pigeon, your inbox assistant. ${CAPABILITIES} Try "what needs a reply?" or "draft an email to Sam about Friday".`,
  },
  {
    pattern: /^(?:ok(?:ay)?|k|kk|cool|nice|great|got it|sounds good|alright|all right|sure|yep|yes|yeah|no|nope|nah|lol|lmao|haha+|test(?:ing)?)$/,
    reply: 'Got it. Ask me anything about your mail whenever you like.',
  },
];

/**
 * A ready reply when the message is only a greeting, thanks or a question
 * about Pigeon itself; null for anything that might be about mail.
 */
export function smallTalkReply(query: string): string | null {
  const text = query
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}'?\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Punctuation and a trailing "?" carry no meaning here, except a lone "?".
    .replace(/(?<=\S)\s*\?+$/, '');
  if (!text || text.length > 60) return null;
  return RULES.find((rule) => rule.pattern.test(text))?.reply ?? null;
}

/** System prompt for a message that is not about the mailbox, so the model gets no emails at all. */
export const ASK_CHAT_SYSTEM_PROMPT = [
  'You are Pigeon, a friendly assistant inside the PigeonBox email app.',
  'The user sent a message that is not a question about their emails, so you have no emails to look at.',
  'Reply conversationally in 1 to 3 short sentences. Answer simple general questions directly.',
  'Never write an email, a letter, a sign-off, or placeholders like [Your Name].',
  "If they do ask about their mail, say you couldn't find matching emails and suggest naming a person, subject, or time.",
].join(' ');

/** Rules shared by the mailbox prompts so an unrelated message gets a normal reply, not an answer built from random threads. */
export const ASK_RELEVANCE_RULE =
  'If the question is small talk or not about these emails, ignore the emails, reply briefly and naturally, and cite nothing. Never write an email or a letter unless asked to.';

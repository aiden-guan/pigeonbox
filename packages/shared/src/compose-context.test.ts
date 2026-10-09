import { describe, expect, it } from 'vitest';
import { detectComposeContext, detectComposeCompletion, validComposeHighlight } from './compose-context.js';
describe('ambient compose candidate gate', () => {
  it.each([
    'i dont have any meetings left today', "I don't have any meetings left today.",
    'I have no meetings today.', 'We have no calls tomorrow.',
    "I don’t think I have any appointments on Friday.", 'I have nothing else scheduled tonight.',
  ])('passes calendar statements to reasoning without a recipient or clock time: %s', text => expect(detectComposeContext(text)).not.toBeNull());
  it.each([
    'My afternoon is completely clear.', 'There is nothing else on my plate for today.',
    'I have the whole day to myself.', 'My schedule is wide open.',
    'I am done for the day.', 'Everything on my calendar has wrapped up.',
    'That application is behind me now, I finished it yesterday.',
    'I am back to waiting for their response.',
    "The contract hasn't been signed.", 'The application is already complete.',
  ])('keeps novel personal assertions eligible for semantic reasoning: %s', text => expect(detectComposeContext(text)).not.toBeNull());
  it.each([
    "i don't think i have any upcoming hackathons", "i think i already submitted that",
    "i haven't heard from alex in a while", "i don't think we've discussed pricing yet",
    "i'm pretty sure the interview is remote", "i think the deadline is next week",
    "i don't have anything scheduled that weekend", "i've never talked to them before",
    "we already agreed on the launch date", "i'm still waiting on their contract",
    "i think i paid this already", "i can't remember if i sent it",
    "as far as i know we haven't decided yet", "i should be free tomorrow afternoon",
    "i told them i'd send it friday", "the meeting is in soda hall",
    "i don't think i have anything going on later this month",
  ])('accepts a checkable personal-context statement: %s', text => expect(detectComposeContext(text)).not.toBeNull());
  it.each([
    'thanks!', 'sounds good', 'looking forward to it', "hope you're doing well", 'that makes sense',
    'i like this idea', 'this is really interesting', 'let me know what you think',
    'could you send me the file?', 'what time works for you?', 'best,', 'Hi Alex,',
    'https://example.test/i-already-submitted', '> I paid this already.',
    "i don't like consulting anymore", "i don't want to do consulting anymore", 'i think this product looks ugly',
    'I think this is great.', 'If I submitted it tomorrow, would that work?', 'Maybe I could attend the hackathon.',
    'I will build a spaceship next month as a joke.', "I'm free tomorrow at", 'x'.repeat(1401),
    'On Monday Alex wrote:', "I'm free tomorrow at 3?",
  ])('keeps noise local: %s', text => expect(detectComposeContext(text)).toBeNull());
  it('prefers existing deterministic kinds and validates literal highlights', () => {
    expect(detectComposeContext("I'm free tomorrow at 2.")).toBe('availability');
    const claim="i don't think i have any upcoming hackathons";
    expect(validComposeHighlight(claim,'any upcoming hackathons')).toBe('any upcoming hackathons');
    for(const text of ['hackathons tomorrow','<b>hackathons</b>','https://example.test','x'.repeat(161)]) expect(validComposeHighlight(claim,text)).toBeUndefined();
    expect(validComposeHighlight('hackathons and hackathons','hackathons')).toBeUndefined();
  });
});

it('lets unfinished prose reach AI completion without hard-coded personal sentences', () => {
  for (const text of ['I used to have a paid community', 'The application we discussed was', 'My background includes several years of', 'Our last conversation covered']) expect(detectComposeCompletion(text)).toBe(true);
  for (const text of ['Hi Alex,', 'Thanks for your help', 'I completed my application.', '> I have an old community', 'https://example.test']) expect(detectComposeCompletion(text)).toBe(false);
});
it('preserves factual checks inside polite or subjective framing', () => {
  for (const text of ["I'd love to meet tomorrow at 3pm.", 'I am excited that the contract was already signed.', 'I hope you saw that we agreed on Friday.']) expect(detectComposeContext(text)).not.toBeNull();
});

import { describe, expect, it } from 'vitest';
import { smallTalkReply } from './ask-chat';

describe('smallTalkReply', () => {
  it('answers greetings, thanks and questions about Pigeon', () => {
    for (const text of ['hi', 'Hello!', 'hey there', "what's up?", 'Good morning', 'how are you?', 'thanks!', 'thank you so much', 'bye', 'what can you do?', 'who are you', 'help', 'ok']) {
      expect(smallTalkReply(text), text).toBeTruthy();
    }
  });

  it('leaves anything that might be about mail alone', () => {
    for (const text of ['hi, did Sam reply?', 'thanks email from Dana', 'what needs a reply', 'help me draft an email to Sam', 'hey what did I send today']) {
      expect(smallTalkReply(text), text).toBeNull();
    }
  });
});

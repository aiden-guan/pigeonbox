import { describe, expect, it } from 'vitest';
import { AIJobQueue } from '@pigeonbox/ai';
import { detectPlaceholders } from '@pigeonbox/shared';

describe('AI cache invalidation', () => {
  it('returns cached result for same fingerprint', async () => {
    const q = new AIJobQueue();
    let calls = 0;
    const a = await q.enqueue('classify', 'fp1', async () => {
      calls += 1;
      return { ok: true };
    });
    const b = await q.enqueue('classify', 'fp1', async () => {
      calls += 1;
      return { ok: false };
    });
    expect(a).toEqual(b);
    expect(calls).toBe(1);
  });

  it('recomputes when fingerprint changes', async () => {
    const q = new AIJobQueue();
    let calls = 0;
    await q.enqueue('summary', 'fp1', async () => {
      calls += 1;
      return 1;
    });
    await q.enqueue('summary', 'fp2', async () => {
      calls += 1;
      return 2;
    });
    expect(calls).toBe(2);
  });

  it('recomputes and replaces cache when bypassCache is true', async () => {
    const q = new AIJobQueue();
    let calls = 0;
    const res1 = await q.enqueue('summary', 'fp1', async () => {
      calls += 1;
      return 'first';
    });
    expect(res1).toBe('first');
    expect(calls).toBe(1);

    // Without bypassCache, returns cached 'first'
    const res2 = await q.enqueue('summary', 'fp1', async () => {
      calls += 1;
      return 'second';
    });
    expect(res2).toBe('first');
    expect(calls).toBe(1);

    // With bypassCache, invokes function again and updates cache
    const res3 = await q.enqueue('summary', 'fp1', async () => {
      calls += 1;
      return 'third';
    }, { bypassCache: true });
    expect(res3).toBe('third');
    expect(calls).toBe(2);

    // Subsequent normal call returns 'third'
    const res4 = await q.enqueue('summary', 'fp1', async () => {
      calls += 1;
      return 'fourth';
    });
    expect(res4).toBe('third');
    expect(calls).toBe(2);
  });

  it('aborts signal on timeout and does not write late results to cache', async () => {
    const q = new AIJobQueue();
    let aborted = false;
    let lateFinished = false;

    await expect(
      q.enqueue(
        'classify',
        'fp_timeout',
        async (signal) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
          });
          await new Promise((r) => setTimeout(r, 100));
          lateFinished = true;
          return { ok: true };
        },
        { timeoutMs: 30 },
      ),
    ).rejects.toThrow('timed out');

    expect(aborted).toBe(true);

    // Wait past the late completion
    await new Promise((r) => setTimeout(r, 120));
    expect(lateFinished).toBe(true);

    // Cache must remain empty because the job timed out
    expect(q.getCached('fp_timeout', 'classify')).toBeUndefined();
    expect(q.usageToday.classifications).toBe(0);
  });
});

describe('draft prompt placeholders', () => {
  it('shared detector finds unresolved facts', () => {
    expect(detectPlaceholders('Pay [AMOUNT] via [LINK]')).toEqual(['[AMOUNT]', '[LINK]']);
  });
});

describe('draft suggestion coercion', () => {
  it('accepts raw strings and non-standard JSON keys from smaller models', async () => {
    const { coerceDraftSuggestion, createPromptBackedProvider } = await import('./prompt-provider.js');

    expect(coerceDraftSuggestion('Hi Alice, thanks for the update.')).toEqual({
      mode: 'direct',
      body: 'Hi Alice, thanks for the update.',
      placeholders: [],
    });

    expect(coerceDraftSuggestion({ reply: 'Here is my reply.' })).toEqual({
      mode: 'direct',
      subject: undefined,
      body: 'Here is my reply.',
      placeholders: [],
      confidence: undefined,
    });

    const provider = createPromptBackedProvider('test', async () => ({
      text: 'Thanks for reaching out! Let us meet tomorrow.',
    }));

    const result = await provider.draftReply({
      subject: 'Meeting',
      messages: [{ sender: 'alice@example.com', bodyText: 'Can we meet?', timestamp: 'now' }],
    });

    expect(result.result.body).toBe('Thanks for reaching out! Let us meet tomorrow.');
  });
});

describe('compact on-device drafting', () => {
  it('tells the model who the user is when the email greets them by name', async () => {
    const { compactDraftPrompt } = await import('./draft-prompt.js');
    const prompt = (body: string) =>
      compactDraftPrompt({ subject: 'PR', messages: [{ sender: 'Priya <p@x.io>', bodyText: body, timestamp: '' }], voice: undefined as never }, 'reply').user;
    expect(prompt('Hi Alex,\n\nCan you review the PR?')).toMatch(/Write my reply to Priya\. I am Alex, so do not address me\.$/);
    expect(prompt('Hello everyone,\n\nSections resume.')).toMatch(/Write my reply to Priya\.$/);
  });

  const email = {
    subject: 'Lab access',
    messages: [{
      sender: 'Priya Shah <priya@example.com>',
      bodyText: 'Hi, can you confirm whether you still need badge access to the lab next week? I need to submit the list by Thursday.',
      timestamp: 'now',
    }],
  };

  it('sends plain-text prompts with worked examples and ends the user turn with the task', async () => {
    const { createPromptBackedProvider } = await import('./prompt-provider.js');
    const calls: Array<{ system: string; user: string; options?: { examples?: unknown[] } }> = [];
    const provider = createPromptBackedProvider('local', async (system, user, options) => {
      calls.push({ system, user, options });
      return { text: 'Reply: Hi Priya,\n\nYes, I still need lab access next week. Thanks for checking.' };
    }, { summaryStyle: 'compact', repairInvalidJson: false });

    const result = await provider.draftReply({ ...email, voice: undefined as never, kind: 'reply' });

    expect(result.result.body).toBe('Hi Priya,\n\nYes, I still need lab access next week. Thanks for checking.');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).not.toMatch(/JSON/);
    expect(calls[0]!.user).toMatch(/^From: Priya Shah <priya@example\.com>\nTo: me\nSubject: Lab access/);
    expect(calls[0]!.user.trim().endsWith('Write my reply to Priya Shah.')).toBe(true);
    expect(calls[0]!.options?.examples?.length).toBe(2);
  });

  it('retries once when the model summarizes the email, then fails clearly', async () => {
    const { createPromptBackedProvider } = await import('./prompt-provider.js');
    const outputs = [
      'The email is asking whether the recipient still needs badge access to the lab.',
      'Hi Priya, yes please keep me on the list. Thanks!',
    ];
    const provider = createPromptBackedProvider('local', async () => ({ text: outputs.shift()! }), {
      summaryStyle: 'compact',
    });
    const result = await provider.draftReply({ ...email, voice: undefined as never, kind: 'reply' });
    expect(result.result.body).toBe('Hi Priya, yes please keep me on the list. Thanks!');

    const stubborn = createPromptBackedProvider('local', async () => ({
      text: 'Priya is informing the recipient that the sender needs to submit the list by Thursday.',
    }), { summaryStyle: 'compact' });
    await expect(stubborn.draftReply({ ...email, voice: undefined as never, kind: 'reply' })).rejects.toThrow(/summarized/);
  });

  const owner = { email: 'aiden@gmail.com', name: 'Aiden Guan' };

  it('names the mailbox owner and answers the newest message someone else wrote', async () => {
    const { compactDraftPrompt, formatDraftContext } = await import('./draft-prompt.js');
    const input = {
      subject: 'Review sessions',
      owner,
      voice: undefined as never,
      kind: 'reply' as const,
      messages: [
        { sender: 'Priya Shah <priya@example.com>', bodyText: 'Can you run the Tuesday review?', timestamp: '1' },
        { sender: 'Aiden <AIDEN@gmail.com>', bodyText: 'Let me check my calendar.', timestamp: '2' },
      ],
    };
    const user = compactDraftPrompt(input, 'reply').user;
    expect(user).toMatch(/^From: Priya Shah <priya@example\.com>\nTo: me \(Aiden Guan\)\n/);
    expect(user).toContain('Can you run the Tuesday review?');
    expect(user).not.toContain('Let me check my calendar.');
    expect(user).toMatch(/I am Aiden Guan, so do not address me\.$/);

    const full = formatDraftContext(input, 'reply', 'full', 24_000);
    expect(full).toMatch(/Newest message to answer from Priya Shah <priya@example\.com> at 1/);
    expect(full).toMatch(/Later message 1 from Aiden <AIDEN@gmail\.com> \(me\)/);
  });

  it('keeps automated senders brief', async () => {
    const { compactDraftPrompt } = await import('./draft-prompt.js');
    const user = compactDraftPrompt({
      subject: 'Your response',
      owner,
      voice: undefined as never,
      kind: 'reply',
      messages: [{ sender: 'Forms Response Receipts <forms-receipts-noreply@google.com>', bodyText: 'Thanks for filling out the form.', timestamp: '' }],
    }, 'reply').user;
    expect(user).toMatch(/automated message, so one short sentence is enough\.$/);
  });

  it('readdresses a draft that greets the owner instead of the sender', async () => {
    const { fixOwnerGreeting, draftQualityIssue } = await import('./draft-prompt.js');
    const input = { ...email, owner, voice: undefined as never, kind: 'reply' as const };
    expect(fixOwnerGreeting('Hi Aiden, thanks for the note. I still need access.', input)).toBe('Hi Priya,\n\nThanks for the note. I still need access.');
    const receipt = { ...input, messages: [{ sender: 'forms-receipts-noreply@google.com', bodyText: 'Your response was recorded.', timestamp: '' }] };
    expect(fixOwnerGreeting('Hi Aiden, thank you for sharing the details.', receipt)).toBe('Thank you for sharing the details.');
    expect(fixOwnerGreeting('Hi Priya, sounds good.', input)).toBe('Hi Priya, sounds good.');
    expect(draftQualityIssue(email.messages, 'Hi Aiden, thank you for sharing this with me today.', owner)).toMatch(/addressed the reply to you/);
  });

  it('replaces the model sign-off with the saved one and never a stranger name', async () => {
    const { finishDraft, draftNeedsRefresh } = await import('./draft-prompt.js');
    const voice = { name: 'Aiden', about: '', greeting: 'Hi', signoff: 'Best', concision: 'medium', capitalization: 'normal', formality: 'neutral', emoji: false, schedulingPreference: '', personalInstructions: '' } as const;
    const input = { ...email, owner, voice, kind: 'reply' as const };
    expect(finishDraft('Hi Priya, I would love to attend. Looking forward to it! Best regards, Alex Kim University of California Berkeley', input))
      .toBe('Hi Priya, I would love to attend. Looking forward to it!\n\nBest,\nAiden');
    expect(finishDraft('Hi Priya,\n\nYes, I still need access.\n\nThanks,\nDana', input)).toBe('Hi Priya,\n\nYes, I still need access.\n\nBest,\nAiden');
    // A closing sentence is content, not a sign-off.
    expect(finishDraft('Sounds good. Thanks for organizing', input)).toBe('Sounds good. Thanks for organizing\n\nBest,\nAiden');
    expect(finishDraft('Yes, I still need access. Thanks!', input)).toBe('Yes, I still need access.\n\nBest,\nAiden');
    const finished = finishDraft('Yes, I still need access.', input);
    expect(finishDraft(finished, input)).toBe(finished);
    expect(draftNeedsRefresh(finished, input)).toBe(false);
    expect(draftNeedsRefresh('Yes. Best regards, Alex Kim', input)).toBe(true);
  });

  it('writes as the saved profile in the compact prompt and its examples', async () => {
    const { compactDraftPrompt } = await import('./draft-prompt.js');
    const voice = { name: 'Aiden', about: 'CS student at UC Berkeley', greeting: 'Hi', signoff: 'Best', concision: 'medium', capitalization: 'normal', formality: 'neutral', emoji: false, schedulingPreference: '', personalInstructions: '' } as const;
    const prompt = compactDraftPrompt({ ...email, voice, kind: 'reply' }, 'reply');
    expect(prompt.system).toContain('About the user: CS student at UC Berkeley');
    expect(prompt.system).toMatch(/Do not write a sign-off/);
    expect(prompt.user).toMatch(/To: me \(Aiden\)/);
    expect(JSON.stringify(prompt.examples)).not.toMatch(/Alex/);
  });

  it('flags third-person narration but accepts ordinary replies', async () => {
    const { draftQualityIssue } = await import('./draft-prompt.js');
    expect(draftQualityIssue(email.messages, 'This message informs the reader about new lab access rules.')).toMatch(/summarized/);
    expect(draftQualityIssue(email.messages, 'The sender wants to know if badge access is still needed.')).toMatch(/summarized/);
    expect(draftQualityIssue(email.messages, 'Thanks for your email! Yes, I still need access next week.')).toBeNull();
  });

  it('removes a model preamble before the subject without dropping the reply', async () => {
    const { cleanCompactDraft } = await import('./draft-prompt.js');
    expect(cleanCompactDraft("Got it, here's my response:\nSubject: Re: Verification\nThanks for confirming receipt."))
      .toBe('Thanks for confirming receipt.');
    expect(cleanCompactDraft('Here is your draft:\nSubject: Verification\nHi Priya,\n\nI will check.'))
      .toBe('Hi Priya,\n\nI will check.');
    expect(cleanCompactDraft('Got it, thanks for confirming receipt.')).toBe('Got it, thanks for confirming receipt.');
  });

  it('retries unsupported completed actions and refuses a persistent invented claim', async () => {
    const { createPromptBackedProvider } = await import('./prompt-provider.js');
    const outputs = ["I've reviewed the logs and everything seems to be in order.", 'Thanks for confirming receipt.'];
    const complete = vi.fn(async () => ({ text: outputs.shift()! }));
    const provider = createPromptBackedProvider('local', complete, { summaryStyle: 'compact' });
    const input = { ...email, owner, voice: undefined as never, kind: 'reply' as const };
    expect((await provider.draftReply(input)).result.body).toBe('Thanks for confirming receipt.\n\nAiden');
    expect(complete).toHaveBeenCalledTimes(2);
    const stubborn = createPromptBackedProvider('local', async () => ({ text: "I've reviewed the logs and everything seems to be in order." }), { summaryStyle: 'compact' });
    await expect(stubborn.draftReply(input)).rejects.toThrow(/completed an action/);
  });

  it('only grounds a completed action in the owner current text', async () => {
    const { draftQualityIssue } = await import('./draft-prompt.js');
    const claim = "I've reviewed the logs.";
    const message = { sender: 'Priya <priya@example.com>', bodyText: claim };
    expect(draftQualityIssue([message], claim, owner)).toMatch(/completed an action/);
    expect(draftQualityIssue([{ sender: owner.email, bodyText: 'Thanks.\nOn Thursday Priya wrote:\n> I have reviewed the logs.' }], claim, owner)).toMatch(/completed an action/);
    expect(draftQualityIssue([{ sender: owner.email, bodyText: 'I have reviewed the logs.' }], "I've reviewed the logs. All looks good.", owner)).toBeNull();
    expect(draftQualityIssue([message], "I haven't reviewed the logs yet.", owner)).toBeNull();
    expect(draftQualityIssue([message], "I've received it and have verified it successfully.", owner)).toMatch(/completed an action/);
  });

  it('refuses the real model wrapper after an opening acknowledgment', async () => {
    const { createPromptBackedProvider } = await import('./prompt-provider.js');
    const provider = createPromptBackedProvider('local', async () => ({ text:
      "Thanks for sharing the details. Here's my response:\nSubject: Confirmation of ZIP Verification\nDear Aiden,\nI've received it and have verified it successfully.",
    }), { summaryStyle: 'compact' });
    await expect(provider.draftReply({ ...email, owner, voice: undefined as never, kind: 'reply' }))
      .rejects.toThrow(/explanation or subject/);
  });
});

describe('summary thread formatting and coercion', () => {
  it('keeps the compact model on the latest update when an older notice is quoted', async () => {
    const { formatThreadForSummary } = await import('./summary-prompt.js');
    const formatted = formatThreadForSummary({
      subject: 'Tutoring Sections Update for Week 5',
      includeOlder: false,
      messages: [{
        sender: 'instructor@example.com',
        bodyText: 'The website reopened. Sections resume Week 6 on 9/28.\n----------------\nPrevious Announcement: No sections during Week 5.',
      }],
    });
    expect(formatted).toMatch(/Sections resume Week 6/);
    expect(formatted).not.toMatch(/Week 5|Previous Announcement/);
  });

  it('formats thread cleanly with senders, timestamps, and message blocks', async () => {
    const { formatThreadForSummary } = await import('./summary-prompt.js');
    const formatted = formatThreadForSummary({
      subject: 'Bug report: login failure',
      messages: [
        { sender: 'john@example.com', bodyText: 'Login fails on iOS 17.', timestamp: '2026-09-23 10:00' },
        { sender: 'sarah@example.com', bodyText: 'Confirmed, hotfix tomorrow.', timestamp: '2026-09-23 10:15' },
      ],
    });

    expect(formatted).toContain('Subject: Bug report: login failure');
    expect(formatted).toContain('--- Message 1 from john@example.com [authorRole=other] at 2026-09-23 10:00 ---');
    expect(formatted).toContain('Login fails on iOS 17.');
    expect(formatted).toContain('--- Message 2 from sarah@example.com [authorRole=other] at 2026-09-23 10:15 ---');
    expect(formatted).toContain('Confirmed, hotfix tomorrow.');
  });

  it('coerceThreadSummary extracts reasoning and sanitizes output', async () => {
    const { coerceThreadSummary } = await import('./prompt-provider.js');
    const coerced = coerceThreadSummary({
      reasoning: 'John found a bug, Sarah confirmed and will deploy a hotfix tomorrow.',
      one_line: 'Sarah verified the login bug reported by John and will patch it tomorrow.',
      key_points: ['Issue affects iOS 17 only.'],
      decisions: ['Deploy patch tomorrow.'],
      questions: ['Want a discount?'], // rhetorical marketing question should be stripped
      commitments: ['Sarah will deploy patch'],
      dates: ['Tomorrow'],
      actions: ['Review patch PR'],
    }) as any;

    expect(coerced.reasoning).toBe('John found a bug, Sarah confirmed and will deploy a hotfix tomorrow.');
    expect(coerced.oneLine).toBe('Sarah verified the login bug reported by John and will patch it tomorrow.');
    expect(coerced.keyPoints).toEqual(['Issue affects iOS 17 only.']);
    expect(coerced.decisions).toEqual(['Deploy patch tomorrow.']);
    expect(coerced.unansweredQuestions).toEqual([]);
    expect(coerced.commitments).toEqual(['Sarah will deploy patch']);
    expect(coerced.dates).toEqual(['Tomorrow']);
    expect(coerced.actionItems).toEqual(['Review patch PR']);
  });
});

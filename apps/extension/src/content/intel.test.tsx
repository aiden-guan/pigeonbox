/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { applyCategoryChip, rowsForThread } from './chips';
import { isVisibleCommand, paletteCommands, VISIBLE_COMMANDS } from './commands';
import { ThreadIntelCard } from './thread-panel';

describe('commands', () => {
  it('only exposes commands that have real handlers', () => {
    expect(VISIBLE_COMMANDS.map((command) => command.id)).toEqual([
      'ask',
      'summarize',
      'draft',
      'remind',
      'archive',
      'settings',
      'mark_respond',
      'mark_waiting',
      'mark_fyi',
      'cloud',
    ]);
    for (const command of VISIBLE_COMMANDS) expect(isVisibleCommand(command.id)).toBe(true);
    expect(isVisibleCommand('index')).toBe(false);
    expect(isVisibleCommand('always_archive')).toBe(false);
  });

  it('shows Cloud commands only when Cloud’s always-on features are on', () => {
    expect(paletteCommands('', false).map((command) => command.id)).not.toContain('cloud');
    expect(paletteCommands('', true).map((command) => command.id)).toContain('cloud');
    expect(paletteCommands('approv', true).map((command) => command.id)).toEqual(['cloud']);
  });
});

describe('reactive intelligence', () => {
  it('updates a row chip when classification arrives', () => {
    document.body.innerHTML = '<table><tbody><tr class="zA" data-legacy-thread-id="t1"><td class="y6"><span class="bog">Hello</span></td></tr></tbody></table>';
    const row = document.querySelector('tr') as HTMLElement;
    applyCategoryChip(row, 'FYI', false);
    expect(row.textContent).toContain('FYI');
    applyCategoryChip(row, 'RESPOND', true);
    expect(row.textContent).toContain('Respond');
    expect(row.querySelector('.gi-cat-chip')?.getAttribute('data-manual')).toBe('1');
  });

  it('finds a row when the thread id is on the subject', () => {
    document.body.innerHTML = `
      <div role="list">
        <div role="listitem">
          <span data-legacy-thread-id="t9">Hello</span>
        </div>
      </div>
    `;
    expect(rowsForThread('t9')).toHaveLength(1);
  });

  it('shows the summary and draft button when they are ready', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<ThreadIntelCard intel={{ classification: { category: 'FYI' } }} onDraft={() => undefined} onRemind={() => undefined} />);
    });
    expect(host.textContent).toContain('No summary yet.');
    expect(host.textContent).not.toContain('Draft reply');
    await act(async () => {
      root.render(
        <ThreadIntelCard
          intel={{
            classification: { category: 'RESPOND', needsReply: true },
            summary: { source: 'model', aiStatus: 'success', summary: { oneLine: 'Asked about Thursday.' } },
            draft: { suggestion: { body: 'Thursday works.' } },
          }}
          onDraft={() => undefined}
          onRemind={() => undefined}
        />,
      );
    });
    expect(host.textContent).toContain('Asked about Thursday.');
    expect(host.textContent).toContain('Draft reply');
    await act(async () => {
      root.render(
        <ThreadIntelCard
          intel={{ classification: { category: 'RESPOND', needsReply: true } }}
          drafting
          onDraft={() => undefined}
          onRemind={() => undefined}
        />,
      );
    });
    expect(host.textContent).toContain('Drafting…');
    expect([...host.querySelectorAll('button')].find((button) => button.textContent === 'Drafting…')?.disabled).toBe(true);
    await act(async () => {
      root.render(
        <ThreadIntelCard
          intel={{ classification: { category: 'FYI' } }}
          pending="Reading this thread…"
          tracking={{
            opened: true,
            markLabel: 'Opened',
            headline: 'aiden@example.com opened your email a minute ago.',
            detail: 'First opened less than a minute after you sent.',
            countLabel: 'Opened once',
          }}
          onDraft={() => undefined}
          onRemind={() => undefined}
        />,
      );
    });
    expect(host.textContent).toContain('opened your email');
    expect(host.textContent).toContain('Reading this thread');
    await act(async () => {
      root.render(
        <ThreadIntelCard
          intel={{
            classification: { category: 'FYI' },
            summary: { source: 'model', aiStatus: 'success', summary: { oneLine: 'A short note to Dylan.' } },
          }}
          tracking={{
            opened: true,
            markLabel: 'Opened',
            headline: 'aiden@example.com opened your email a minute ago.',
            detail: 'First opened less than a minute after you sent.',
            countLabel: 'Opened once',
          }}
          onDraft={() => undefined}
          onRemind={() => undefined}
        />,
      );
    });
    expect(host.textContent).toContain('A short note to Dylan.');
    expect(host.textContent).toContain('opened your email');
    expect(host.textContent).not.toContain('Reading this thread');
    await act(async () => {
      root.render(
        <ThreadIntelCard
          intel={{ classification: { category: 'PROMOTIONS' } }}
          pending="Could not summarize this thread."
          preview="Our weekend sale starts Friday."
          onDraft={() => undefined}
          onRemind={() => undefined}
          onRetrySummary={() => undefined}
        />,
      );
    });
    expect(host.textContent).toContain('Could not summarize');
    expect(host.textContent).toContain('Retry');
    expect(host.textContent).not.toContain('Our weekend sale starts Friday.');
    await act(async () => {
      root.render(
        <ThreadIntelCard
          intel={{
            classification: { category: 'PROMOTIONS' },
            summary: {
              source: 'model', aiStatus: 'success',
              summary: {
                oneLine: 'ACA invited you to the Berkeley China Summit with TikTok Recruiting.',
                keyPoints: ['TikTok Recruiting is a partner'],
                dates: ['Friday'],
                actionItems: ['Open the summit details'],
              },
            },
          }}
          onDraft={() => undefined}
          onRemind={() => undefined}
        />,
      );
    });
    expect(host.querySelector('li')?.textContent).toBe('TikTok Recruiting is a partner');
    expect(host.textContent).toContain('Friday');
    const details = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Details');
    expect(details).toBeFalsy();
    expect(host.textContent).not.toContain('Next steps');
    root.unmount();
  });

  it('shows actionable next steps without exposing model reasoning or stale detail sections', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <ThreadIntelCard
          intel={{
            classification: { category: 'RESPOND', needsReply: true },
            summary: {
              source: 'model', aiStatus: 'success',
              summary: {
                oneLine: 'Onboarding instructions sent.',
                reasoning: 'The sender is UC Berkeley guiding participants through onboarding.',
                decisions: ['Section 1 confirmed'],
                commitments: ['Representative must be provided info'],
                actionItems: ['Provide authorized representative with info'],
                unansweredQuestions: ['Who is the representative?'],
              },
            },
          }}
          onDraft={() => undefined}
          onRemind={() => undefined}
        />,
      );
    });
    expect(host.textContent).toContain('Onboarding instructions sent.');
    expect(host.textContent).not.toContain('Reasoning');
    expect(host.textContent).not.toContain('The sender is UC Berkeley guiding participants through onboarding.');
    expect(host.textContent).not.toContain('Decisions');
    expect(host.textContent).not.toContain('Section 1 confirmed');
    expect(host.textContent).not.toContain('Commitments');
    expect(host.textContent).not.toContain('Representative must be provided info');
    expect(host.textContent).not.toContain('Next steps');
    expect(host.textContent).toContain('To do');
    expect(host.textContent).toContain('Provide authorized representative with info');
    expect(host.textContent).not.toContain('Open questions');
    const details = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Details');
    expect(details).toBeFalsy();
    root.unmount();
  });

  it('hides the card to a pill and brings it back', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <ThreadIntelCard
          intel={{
            classification: { category: 'RESPOND', needsReply: true },
            summary: { source: 'model', aiStatus: 'success', summary: { oneLine: 'Asked about Thursday.', keyPoints: ['Thursday is open'] } },
            draft: { suggestion: { body: 'Thursday works.' } },
          }}
          onDraft={() => undefined}
          onRemind={() => undefined}
        />,
      );
    });
    const hide = host.querySelector('[aria-label="Hide intelligence"]') as HTMLButtonElement;
    await act(async () => {
      hide.click();
    });
    expect(host.textContent).not.toContain('Draft reply');
    const show = host.querySelector('[aria-label="Show intelligence"]') as HTMLButtonElement;
    expect(show?.textContent).toContain('Respond');
    await act(async () => {
      show.click();
    });
    expect(host.textContent).toContain('Draft reply');
    expect(host.textContent).toContain('Thursday is open');
    root.unmount();
  });

  it('suppresses open questions and cleans dates for promotional emails', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <ThreadIntelCard
          intel={{
            classification: { category: 'PROMOTIONS' },
            summary: {
              source: 'model', aiStatus: 'success',
              summary: {
                oneLine: 'RecWell announced their September programs.',
                dates: ['September', 'Wednesday', 'September 30'],
                unansweredQuestions: ['...', 'OAKBERRY Want a healthy and delicious grub?'],
                actionItems: ['Sign up online'],
              },
            },
          }}
          onDraft={() => undefined}
          onRemind={() => undefined}
        />,
      );
    });

    // Dates should be cleaned to only 'September 30'
    expect(host.textContent).toContain('September 30');
    const dateElements = host.querySelectorAll('.gi-date');
    expect(dateElements).toHaveLength(1);
    expect(dateElements[0]?.textContent?.trim()).toBe('September 30');

    root.unmount();
  });

  it('flattens a dashed summary and hides bare numeric dates', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <ThreadIntelCard
          intel={{
            classification: { category: 'NOTIFICATIONS' },
            summary: {
              source: 'model', aiStatus: 'success',
              summary: {
                oneLine:
                  'Data C8: Tutoring Sections Update for Week 5. ---------------- Previous Announcement: There will be no tutoring sections during Week 5.',
                dates: ['9/28', '9/23', 'Week 6 starts Sep 28'],
              },
            },
          }}
          onDraft={() => undefined}
          onRemind={() => undefined}
        />,
      );
    });
    expect(host.textContent).not.toMatch(/-{3,}/);
    expect(host.textContent).not.toContain('Previous Announcement');
    expect(host.textContent).not.toContain('9/28');
    expect(host.textContent).not.toContain('9/23');
    expect(host.textContent).toContain('Week 6 starts Sep 28');

    // Details button and drawer should not be present
    const details = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Details');
    expect(details).toBeFalsy();
    expect(host.textContent).not.toContain('Open questions');
    expect(host.textContent).not.toContain('Next steps');
    root.unmount();
  });

  it('renders pending status with model name and preview fallback', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <ThreadIntelCard
          intel={{
            classification: { category: 'RESPOND', needsReply: true },
          }}
          pending="Analyzing with gpt-4o-mini…"
          preview="A draft question about meeting times."
          onDraft={() => undefined}
          onRemind={() => undefined}
        />,
      );
    });
    expect(host.textContent).toContain('Analyzing with gpt-4o-mini…');
    expect(host.textContent).toContain('Summary');
    expect(host.textContent).not.toContain('Message preview');
    expect(host.textContent).not.toContain('A draft question about meeting times.');
    root.unmount();
  });
});

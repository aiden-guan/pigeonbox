import { useEffect } from 'react';
import { trackProductEvent } from '../ui/analytics';
import type { Briefing } from '@pigeonbox/api-contract';
import { SourceChips } from './SourceChips';
import { openCloud } from '../ui/cloud-features';
export function BriefingReader({
  briefing,
  onBack,
  onOpenThread,
}: {
  briefing: Briefing;
  onBack: () => void;
  onOpenThread: (id: string, accountId?: string) => void;
}) {
  useEffect(() => {
    trackProductEvent('first_briefing_viewed', { surface: 'sidepanel', mode: 'cloud' });
  }, []);
  return (
    <article className="gi-cloud-reader">
      <button type="button" className="gi-text-btn" onClick={onBack}>
        ← Back
      </button>
      <h2>{briefing.title}</h2>
      <p className="gi-muted">Prepared {new Date(briefing.generatedAt).toLocaleString()}</p>
      {briefing.sections.map((section) => (
        <section key={section.id} className="gi-cloud-block">
          <h3>{section.title}</h3>
          {section.items.length ? (
            <ul className="gi-brief-preview">
              {section.items.map((item, index) => (
                <li key={index}>
                  {item.text}
                  <SourceChips
                    sources={briefing.sources.filter((source) => item.sourceIds.includes(source.id))}
                    onOpenThread={onOpenThread}
                  />
                  {item.threadId &&
                  !briefing.sources.some((source) => item.sourceIds.includes(source.id) && source.gmailThreadId) ? (
                    <button type="button" className="gi-source" onClick={() => onOpenThread(item.threadId!)}>
                      Open thread
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="gi-muted">{section.empty || 'No items in this section.'}</p>
          )}
        </section>
      ))}
      <p className="gi-muted">{briefing.coverageNote}</p>
      <button type="button" className="gi-btn gi-btn-ghost" onClick={() => openCloud('briefings')}>
        Manage Cloud briefings ↗
      </button>
    </article>
  );
}

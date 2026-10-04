import type { SourceRef } from '@pigeonbox/api-contract';
import type { ReactNode } from 'react';

/**
 * Renders an Ask Pigeon answer: a small, safe subset of markdown (paragraphs,
 * bullet and numbered lists, headings as small labels, **bold**, *italic*, `code`) built as React
 * elements, never as HTML, because answers quote email content. Citation
 * markers like [2] become buttons that open the cited source.
 */
export function AnswerText(props: { text: string; sources: SourceRef[]; onOpenSource: (source: SourceRef) => void }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let paragraph: string[] = [];
  const flushParagraph = () => {
    // The opening paragraph is the direct answer; it is set slightly heavier than the details.
    if (paragraph.length) blocks.push(<p key={blocks.length} className={blocks.length ? undefined : 'pb-answer-lead'}>{inline(paragraph.join(' '), props)}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((item, index) => <li key={index}>{inline(item, props)}</li>);
    blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
    list = null;
  };
  for (const raw of props.text.split('\n')) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
    } else if (heading) {
      flushParagraph();
      flushList();
      blocks.push(<p key={blocks.length} className="pb-answer-heading">{inline(heading[1]!, props)}</p>);
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return <div className="pb-answer-text">{blocks}</div>;
}

function inline(text: string, props: { sources: SourceRef[]; onOpenSource: (source: SourceRef) => void }): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /\[(\d{1,2})\]|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\s][^*]*)\*/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > last) out.push(text.slice(last, match.index));
    const key = `${match.index}`;
    if (match[1]) {
      const index = Number(match[1]) - 1;
      const source = props.sources[index];
      out.push(
        source ? (
          <button key={key} type="button" className="pb-citation-ref" title={source.title} onClick={() => props.onOpenSource(source)}>
            [{String(index + 1).padStart(2, '0')}]
          </button>
        ) : null,
      );
    } else if (match[2]) out.push(<strong key={key}>{match[2]}</strong>);
    else if (match[3]) out.push(<code key={key}>{match[3]}</code>);
    else if (match[4]) out.push(<em key={key}>{match[4]}</em>);
    last = match.index! + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

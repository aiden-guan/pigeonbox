import type { SourceRef } from '@pigeonbox/api-contract';

export function safeSourceUrl(value: string | undefined): string | null {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function SourceChips({ sources, onOpenThread }: { sources: SourceRef[]; onOpenThread: (id: string, accountId?: string) => void }) {
  return <span className="gi-source-chips">{sources.map((source) => source.gmailThreadId ? <button type="button" key={source.id} className="gi-source" onClick={() => onOpenThread(source.gmailThreadId!, source.accountId)}>{source.title}</button> : safeSourceUrl(source.url) ? <a key={source.id} className="gi-source" href={safeSourceUrl(source.url)!} target="_blank" rel="noreferrer">{source.title}</a> : <span key={source.id} className="gi-source is-static">{source.title}</span>)}</span>;
}

import { useState } from 'react';
import type { RelationshipBrief, RouteResponse } from '@pigeonbox/api-contract';
import { callCloud } from './cloud-api';
import { SourceChips } from './SourceChips';
import { relative } from './WaitingView';
import { openCloud } from '../ui/cloud-features';
export function ContactsView({ onOpenThread }: { onOpenThread: (id: string, accountId?: string) => void }) {
  const [query, setQuery] = useState('');
  const [contacts, setContacts] = useState<RouteResponse<'contacts'>['contacts'] | null>(null);
  const [brief, setBrief] = useState<RelationshipBrief | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function search() {
    setBusy(true);
    setError('');
    setBrief(null);
    const result = await callCloud('contacts', { query, limit: 30 });
    setBusy(false);
    if (result.ok) setContacts(result.data.contacts);
    else setError(result.reason);
  }
  async function open(contactId: string) {
    setBusy(true);
    setError('');
    const result = await callCloud('contactBrief', { contactId });
    setBusy(false);
    if (result.ok) setBrief(result.data.brief);
    else setError(result.reason);
  }
  return (
    <section className="gi-cloud-reader">
      <h2>Contacts</h2>
      <p className="gi-muted">Facts from synced conversations: recent topics, meetings and promises.</p>
      <form
        className="gi-cloud-actions"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <input
          className="gi-field"
          aria-label="Search contacts"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Name or address"
          maxLength={200}
        />
        <button type="submit" className="gi-btn" disabled={busy}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </form>
      {error ? (
        <p className="gi-warn" role="alert">
          {error}
        </p>
      ) : null}
      {brief ? (
        <>
          <h3>{brief.contact.name || brief.contact.email}</h3>
          <p>{brief.whoTheyAre}</p>
          <p className="gi-muted">
            {brief.contact.lastInteractionAt ? `Last contact ${relative(brief.contact.lastInteractionAt)} · ` : ''}
            {brief.contact.sentCount} sent · {brief.contact.receivedCount} received
          </p>
          {brief.lastDiscussed ? (
            <p>
              {brief.lastDiscussed.text}
              <SourceChips sources={[brief.lastDiscussed.source]} onOpenThread={onOpenThread} />
            </p>
          ) : null}
          {brief.nextMeeting ? (
            <p>
              Next meeting: {brief.nextMeeting.title} · {new Date(brief.nextMeeting.start).toLocaleString()}
              <SourceChips sources={[brief.nextMeeting.source]} onOpenThread={onOpenThread} />
            </p>
          ) : null}
          {[
            ['You promised', brief.youOwe],
            ['They promised', brief.theyOwe],
          ].map(([label, items]) => (
            <section className="gi-cloud-block" key={label as string}>
              <h3>{label as string}</h3>
              {(items as RelationshipBrief['youOwe']).length ? (
                (items as RelationshipBrief['youOwe']).map((item) => (
                  <p key={item.id}>
                    {item.text}
                    <SourceChips sources={[item.source]} onOpenThread={onOpenThread} />
                  </p>
                ))
              ) : (
                <p className="gi-muted">No open commitments in synced context.</p>
              )}
            </section>
          ))}
          <h3>Relevant conversations</h3>
          {brief.importantThreads.map((thread) => (
            <button
              type="button"
              className="gi-automatic-row"
              key={thread.threadId}
              onClick={() => onOpenThread(thread.threadId)}
            >
              <strong>{thread.subject}</strong>
              <span>{relative(thread.lastMessageAt)}</span>
            </button>
          ))}
        </>
      ) : contacts ? (
        contacts.length ? (
          contacts.map((contact) => (
            <button
              type="button"
              className="gi-automatic-row"
              key={contact.id}
              disabled={busy}
              onClick={() => void open(contact.id)}
            >
              <strong>{contact.name || contact.email}</strong>
              <span>
                {contact.lastInteractionAt ? relative(contact.lastInteractionAt) : 'No recent interaction'} ·{' '}
                {contact.openCommitments} open commitments
              </span>
            </button>
          ))
        ) : (
          <p className="gi-muted">No matching contacts in synced mail.</p>
        )
      ) : (
        <p className="gi-muted">Search for a contact to see relevant context.</p>
      )}
      <button type="button" className="gi-text-btn" onClick={() => openCloud('contacts')}>
        Manage contacts ↗
      </button>
    </section>
  );
}

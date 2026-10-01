import { useState } from 'react';
import type { RelationshipBrief, RouteResponse, ThreadIntel } from '@pigeonbox/api-contract';
import { Orb } from '../../ui/Orb';

export function CloudContext({
  intel,
  capabilities,
  mailbox,
  onInsert,
}: {
  intel: ThreadIntel;
  capabilities: readonly string[];
  mailbox?: string;
  onInsert: (body: string) => void;
}) {
  const [relationship, setRelationship] = useState<RelationshipBrief | null>(null);
  const [calendar, setCalendar] = useState<RouteResponse<'calendarAvailability'> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [needsConnection, setNeedsConnection] = useState(false);
  const [error, setError] = useState('');
  const scheduling =
    intel.draft?.kind === 'scheduling' || /schedul|meeting|availability/i.test(intel.state.nextAction.kind);
  async function load(kind: 'relationship' | 'calendar') {
    setBusy(kind);
    setError('');
    setNeedsConnection(false);
    try {
      const response = await new Promise<{
        ok?: boolean;
        reason?: string;
        needsConnection?: boolean;
        data?: { brief?: RelationshipBrief } & Partial<RouteResponse<'calendarAvailability'>>;
      }>((resolve) =>
        chrome.runtime.sendMessage(
          { type: 'CLOUD_THREAD_CONTEXT', kind, threadId: intel.threadId, mailbox },
          (result) => resolve(chrome.runtime.lastError ? { ok: false } : (result ?? {})),
        ),
      );
      if (!response.ok) {
        setError(response.reason || 'Cloud context could not load. Try again.');
        setNeedsConnection(Boolean(response.needsConnection));
      } else if (kind === 'relationship' && response.data?.brief) setRelationship(response.data.brief);
      else if (
        kind === 'calendar' &&
        response.data?.slots &&
        response.data.timeZone &&
        response.data.note !== undefined
      )
        setCalendar(response.data as RouteResponse<'calendarAvailability'>);
    } catch {
      setError('Cloud context could not load. Try again.');
    } finally {
      setBusy(null);
    }
  }
  function slotText(slot: RouteResponse<'calendarAvailability'>['slots'][number], timeZone: string) {
    return `${new Date(slot.start).toLocaleString(undefined, { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}–${new Date(slot.end).toLocaleTimeString(undefined, { timeZone, hour: 'numeric', minute: '2-digit' })}`;
  }
  return (
    <>
      {capabilities.includes('cloud_relationships') ? (
        <details className="gi-cloud-context">
          <summary>Relationship context</summary>
          {relationship ? (
            <>
              <strong>{relationship.contact.name || relationship.contact.email}</strong>
              <p className="gi-cloud-why">{relationship.whoTheyAre}</p>
              {relationship.contact.lastInteractionAt ? (
                <p className="gi-cloud-why">
                  Last contact {new Date(relationship.contact.lastInteractionAt).toLocaleDateString()} ·{' '}
                  {relationship.contact.sentCount} sent · {relationship.contact.receivedCount} received
                </p>
              ) : null}
              {relationship.lastDiscussed ? (
                <p className="gi-cloud-why">Last discussed: {relationship.lastDiscussed.text}</p>
              ) : null}
              <p className="gi-cloud-why">
                {relationship.youOwe.length} commitments from you · {relationship.theyOwe.length} from them
              </p>
              {relationship.nextMeeting ? (
                <p className="gi-cloud-why">
                  Next meeting: {relationship.nextMeeting.title} ·{' '}
                  {new Date(relationship.nextMeeting.start).toLocaleString()}
                </p>
              ) : null}
            </>
          ) : (
            <button
              type="button"
              className="gi-action is-ghost"
              disabled={Boolean(busy)}
              onClick={() => void load('relationship')}
            >
              Load relationship context
            </button>
          )}
        </details>
      ) : null}
      {scheduling && capabilities.includes('cloud_calendar') ? (
        <details className="gi-cloud-context">
          <summary>Calendar availability</summary>
          <p className="gi-cloud-why">
            Options over the next seven days, using your meeting length and working hours in Cloud.
          </p>
          {calendar ? (
            <>
              <ul className="gi-points">
                {calendar.slots.map((slot) => (
                  <li key={slot.start}>{slotText(slot, calendar.timeZone)}</li>
                ))}
              </ul>
              <p className="gi-cloud-why">
                {calendar.note} · {calendar.timeZone}
              </p>
              {calendar.slots.length ? (
                <button
                  type="button"
                  className="gi-action"
                  onClick={() =>
                    onInsert(
                      `I’m available at these times (${calendar.timeZone}):\n${calendar.slots.map((slot) => slotText(slot, calendar.timeZone)).join('\n')}`,
                    )
                  }
                >
                  Insert availability
                </button>
              ) : (
                <p className="gi-cloud-why">No available times in this window.</p>
              )}
            </>
          ) : (
            <button
              type="button"
              className="gi-action is-ghost"
              disabled={Boolean(busy)}
              onClick={() => void load('calendar')}
            >
              Check availability
            </button>
          )}
        </details>
      ) : null}
      {busy ? (
        <p className="gi-orb-line" role="status">
          <Orb size={14} />
          Checking {busy === 'calendar' ? 'calendar' : 'contact context'}…
        </p>
      ) : null}
      {error ? (
        <p className="gi-cloud-warn" role="alert">
          {error}
        </p>
      ) : null}
      {needsConnection ? (
        <button
          type="button"
          className="gi-action is-ghost"
          onClick={() => chrome.runtime.sendMessage({ type: 'FOCUS_SIDEPANEL', mode: 'cloud', section: 'connections' })}
        >
          Connect Calendar
        </button>
      ) : null}
    </>
  );
}

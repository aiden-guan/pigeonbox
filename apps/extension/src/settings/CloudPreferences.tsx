import { useEffect, useState } from 'react';
import type { Preferences } from '@pigeonbox/api-contract';
import { callCloud } from '../sidepanel/cloud-api';
import { availableCloudFeatures, openCloud } from '../ui/cloud-features';
import { Field, Toggle } from './SettingsComponents';

/** Cloud is the source of truth. Local voice settings remain in the existing profile editor. */
export function CloudPreferences({ capabilities }: { capabilities: readonly string[] }) {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  async function load() {
    setError('');
    const result = await callCloud('preferences');
    if (result.ok) setPrefs(result.data.preferences);
    else setError(result.reason);
  }
  useEffect(() => {
    void load();
  }, []);
  async function save() {
    if (!prefs) return;
    setBusy(true);
    setError('');
    setSaved(false);
    const result = await callCloud('preferencesUpdate', {
      preferences: {
        timeZone: prefs.timeZone,
        workdays: prefs.workdays,
        workingHours: prefs.workingHours,
        calendar: prefs.calendar,
        followUp: prefs.followUp,
        autoDrafts: prefs.autoDrafts,
        briefings: prefs.briefings,
      },
    });
    setBusy(false);
    if (result.ok) {
      setPrefs(result.data.preferences);
      setSaved(true);
    } else setError(result.reason);
  }
  function patch<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    if (prefs) setPrefs({ ...prefs, [key]: value });
    setSaved(false);
  }
  return (
    <div className="space-y-3">
      <p className="gi-muted text-xs">
        These preferences apply to background Cloud work. Sending and invitations always require approval.
      </p>
      {error ? (
        <p className="gi-warn" role="alert">
          {error}
          <button className="gi-text-btn" type="button" onClick={() => void load()}>
            Retry
          </button>
        </p>
      ) : null}
      {prefs ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field label="Time zone">
            <input
              className="gi-field"
              value={prefs.timeZone}
              onChange={(event) => patch('timeZone', event.target.value)}
              required
              maxLength={64}
            />
          </Field>
          <div className="flex gap-3">
            <Field label="Workday starts">
              <input
                className="gi-field"
                type="time"
                required
                value={prefs.workingHours.start}
                onChange={(event) => patch('workingHours', { ...prefs.workingHours, start: event.target.value })}
              />
            </Field>
            <Field label="Workday ends">
              <input
                className="gi-field"
                type="time"
                required
                value={prefs.workingHours.end}
                onChange={(event) => patch('workingHours', { ...prefs.workingHours, end: event.target.value })}
              />
            </Field>
          </div>
          <fieldset>
            <legend className="text-xs gi-muted">Working days</legend>
            <div className="flex gap-2 mt-2">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, index) => (
                <label key={day} className="text-xs">
                  <input
                    type="checkbox"
                    checked={prefs.workdays.includes(index)}
                    onChange={(event) =>
                      patch(
                        'workdays',
                        event.target.checked
                          ? [...prefs.workdays, index]
                          : prefs.workdays.filter((value) => value !== index),
                      )
                    }
                  />
                  {day}
                </label>
              ))}
            </div>
          </fieldset>
          {capabilities.includes('cloud_calendar') ? (
            <>
              <Field label="Meeting length (minutes)">
                <input
                  type="number"
                  className="gi-field"
                  min={5}
                  max={480}
                  required
                  value={prefs.calendar.defaultDurationMinutes}
                  onChange={(event) =>
                    patch('calendar', { ...prefs.calendar, defaultDurationMinutes: Number(event.target.value) })
                  }
                />
              </Field>
              <Field label="Meeting buffer (minutes)">
                <input
                  type="number"
                  className="gi-field"
                  min={0}
                  max={120}
                  required
                  value={prefs.calendar.bufferMinutes}
                  onChange={(event) =>
                    patch('calendar', { ...prefs.calendar, bufferMinutes: Number(event.target.value) })
                  }
                />
              </Field>
            </>
          ) : null}
          <Field label="Follow-up after (business days)">
            <input
              className="gi-field"
              type="number"
              min={1}
              max={30}
              required
              value={prefs.followUp.defaultBusinessDays}
              onChange={(event) =>
                patch('followUp', { ...prefs.followUp, defaultBusinessDays: Number(event.target.value) })
              }
            />
          </Field>
          {capabilities.includes('cloud_auto_drafts') ? (
            <>
              <Toggle
                label="Prepare replies automatically"
                description="PigeonBox writes replies and keeps them in your Drafts queue in Cloud."
                checked={prefs.autoDrafts.enabled}
                onChange={(enabled) => patch('autoDrafts', { ...prefs.autoDrafts, enabled })}
              />
              <Toggle
                label="Also add prepared replies to Gmail"
                description="Ready drafts will also appear in your Gmail Drafts folder. Nothing is sent automatically."
                checked={prefs.autoDrafts.enabled && prefs.autoDrafts.placeInGmail}
                disabled={!prefs.autoDrafts.enabled}
                onChange={(placeInGmail) => patch('autoDrafts', { ...prefs.autoDrafts, placeInGmail })}
              />
            </>
          ) : null}
          {capabilities.includes('cloud_automations') ? (
            <>
              <Toggle
                label="Morning briefing"
                checked={prefs.briefings.morning.enabled}
                onChange={(enabled) =>
                  patch('briefings', { ...prefs.briefings, morning: { ...prefs.briefings.morning, enabled } })
                }
              />
              <Toggle
                label="End-of-day briefing"
                checked={prefs.briefings.endOfDay.enabled}
                onChange={(enabled) =>
                  patch('briefings', { ...prefs.briefings, endOfDay: { ...prefs.briefings.endOfDay, enabled } })
                }
              />
            </>
          ) : null}
          <button className="gi-btn" type="submit" disabled={busy || !prefs.workdays.length}>
            {busy ? 'Saving…' : 'Save Cloud preferences'}
          </button>
          {saved ? (
            <p className="gi-note" role="status">
              Cloud preferences saved.
            </p>
          ) : null}
        </form>
      ) : !error ? (
        <p className="gi-muted" role="status">
          Loading Cloud preferences…
        </p>
      ) : null}
      <div className="gi-cloud-actions">
        {availableCloudFeatures(capabilities).map((feature) => (
          <button className="gi-text-btn" key={feature.id} type="button" onClick={() => openCloud(feature.id)}>
            {feature.title} ↗
          </button>
        ))}
        <button className="gi-text-btn" type="button" onClick={() => openCloud('preferences')}>
          All writing and safety preferences ↗
        </button>
      </div>
    </div>
  );
}

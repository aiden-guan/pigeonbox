import { PreferencesSchema, type Preferences } from '@pigeonbox/api-contract';
import { isValidTimeZone } from '@pigeonbox/shared';
import type { z } from 'zod';
import { one, type SqlExecutor } from '../db/sql.js';
import type { PreferencesUpdateRequestSchema } from '@pigeonbox/api-contract';
import { ApiError } from '../http.js';

/** Derived context is enabled; autonomous actions and retained mail excerpts are off. */
export const DEFAULT_PREFERENCES: Preferences = {
  timeZone: 'UTC',
  workdays: [1, 2, 3, 4, 5],
  workingHours: { start: '09:00', end: '17:30' },
  followUp: { defaultBusinessDays: 3, remindIfOpenedNoReply: false, remindWhenRevived: true, prepareDraftMorningOf: true, morningAt: '08:30' },
  autoDrafts: { enabled: true, placeInGmail: false, kinds: ['reply', 'follow_up', 'scheduling'], learnFromEdits: true },
  calendar: { bufferMinutes: 10, avoidBackToBack: true, preferMornings: false, defaultDurationMinutes: 30, focusBlocks: [] },
  memory: { enabled: true, learnFromReceivedMail: true, learnFromSentMail: true, learnFromDraftEdits: true, realtimeComposeChecks: false, smartComposeCompletion: false },
  fastRecall: { enabled: false, retentionDays: 90 },
  briefings: {
    morning: { enabled: true, at: '08:00' },
    endOfDay: { enabled: false, at: '17:30' },
    meeting: { enabled: true, minutesBefore: 30, externalOnly: true },
  },
  notifications: { extension: true, web: true, followUpsDue: true, approvals: true, engagement: false },
  webResearch: false,
  voice: null,
};

type Update = z.infer<typeof PreferencesUpdateRequestSchema>['preferences'];

function merge(base: Preferences, patch: Partial<Record<keyof Preferences, unknown>>): Preferences {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = (base as Record<string, unknown>)[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current) && key !== 'voice') {
      out[key] = merge(current as Preferences, value as Partial<Record<keyof Preferences, unknown>>);
    } else {
      out[key] = value;
    }
  }
  return out as Preferences;
}

/** Stored settings merged over defaults; anything invalid falls back to the default. */
export function normalizePreferences(stored: unknown, timeZone?: string | null, workdays?: number[] | null): Preferences {
  const merged = merge(DEFAULT_PREFERENCES, (stored && typeof stored === 'object' ? stored : {}) as Partial<Record<keyof Preferences, unknown>>);
  if (timeZone) merged.timeZone = timeZone;
  if (workdays?.length) merged.workdays = workdays;
  const parsed = PreferencesSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_PREFERENCES;
}

export async function loadPreferences(tx: SqlExecutor, userId: string): Promise<Preferences> {
  const row = await one<{ settings: unknown; time_zone: string; workdays: number[] }>(
    tx,
    `select settings, time_zone, workdays from public.user_preferences where user_id = $1::uuid`,
    [userId],
  );
  return normalizePreferences(row?.settings ?? {}, row?.time_zone, row?.workdays);
}

export async function updatePreferences(tx: SqlExecutor, userId: string, patch: Update): Promise<Preferences> {
  // Serialize learning toggles with memory persistence and forget actions.
  await tx.query(`select user_id from public.personal_memory_state where user_id = $1::uuid for update`, [userId]);
  const current = await loadPreferences(tx, userId);
  const next = merge(current, patch as Partial<Record<keyof Preferences, unknown>>);
  if (!isValidTimeZone(next.timeZone)) throw new ApiError('invalid_request', 'That time zone is not recognized.');
  const [startH, startM] = next.workingHours.start.split(':').map(Number);
  const [endH, endM] = next.workingHours.end.split(':').map(Number);
  if (startH! * 60 + startM! >= endH! * 60 + endM!) throw new ApiError('invalid_request', 'Working hours must end after they start.');
  const parsed = PreferencesSchema.safeParse(next);
  if (!parsed.success) throw new ApiError('invalid_request', 'Those preferences are not valid.');
  const { timeZone, workdays, ...settings } = parsed.data;
  await tx.query(
    `insert into public.user_preferences (user_id, time_zone, workdays, settings, updated_at)
     values ($1::uuid, $2, $3::smallint[], $4::jsonb, now())
     on conflict (user_id) do update set time_zone = excluded.time_zone, workdays = excluded.workdays, settings = excluded.settings, updated_at = now()`,
    [userId, timeZone, [...new Set(workdays)].sort(), settings],
  );
  // Fast Recall: turning it off deletes every excerpt now; a shorter retention applies to existing ones.
  if (current.fastRecall.enabled && !parsed.data.fastRecall.enabled) {
    await tx.query(`delete from public.recall_chunks`);
  } else if (parsed.data.fastRecall.retentionDays < current.fastRecall.retentionDays) {
    await tx.query(`update public.recall_chunks set expires_at = least(expires_at, created_at + make_interval(days => $1))`, [parsed.data.fastRecall.retentionDays]);
    await tx.query(`delete from public.recall_chunks where expires_at <= now()`);
  }
  return parsed.data;
}

export function minutesOf(hhmm: string): { hour: number; minute: number } {
  const [hour, minute] = hhmm.split(':').map(Number);
  return { hour: hour ?? 0, minute: minute ?? 0 };
}

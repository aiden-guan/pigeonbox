import { CONNECTION_FEATURES, type ConnectionFeature } from '@pigeonbox/api-contract';

/**
 * Connection features → the narrowest Google scopes PigeonBox can use.
 *
 * Google's model is coarse: the scopes that allow creating drafts or changing
 * labels (`gmail.compose`, `gmail.modify`) also permit sending at the API
 * level. PigeonBox therefore enforces sending in its own policy engine: a send
 * requires the separate `send` feature (the `gmail.send` scope, requested only
 * when the user turns it on) and an approved Tier 3 action. No other code path
 * calls `messages.send`.
 */
const GMAIL = 'https://www.googleapis.com/auth/gmail';
const CALENDAR = 'https://www.googleapis.com/auth/calendar';

export const SCOPES = {
  readonly: `${GMAIL}.readonly`,
  compose: `${GMAIL}.compose`,
  modify: `${GMAIL}.modify`,
  send: `${GMAIL}.send`,
  full: 'https://mail.google.com/',
  calendarReadonly: `${CALENDAR}.readonly`,
  calendarEvents: `${CALENDAR}.events`,
  calendarFull: CALENDAR,
} as const;

export const IDENTITY_SCOPES = ['openid', 'email', 'profile'] as const;

/** The scope PigeonBox requests for each feature. */
export const FEATURE_SCOPE: Record<ConnectionFeature, string> = {
  mail_read: SCOPES.readonly,
  drafts: SCOPES.compose,
  organize: SCOPES.modify,
  calendar_read: SCOPES.calendarReadonly,
  calendar_write: SCOPES.calendarEvents,
  send: SCOPES.send,
};

/** Granted scopes that satisfy each feature. `send` counts only with the explicit send scope. */
const SATISFIED_BY: Record<ConnectionFeature, readonly string[]> = {
  mail_read: [SCOPES.readonly, SCOPES.modify, SCOPES.full],
  drafts: [SCOPES.compose, SCOPES.modify, SCOPES.full],
  organize: [SCOPES.modify, SCOPES.full],
  calendar_read: [SCOPES.calendarReadonly, SCOPES.calendarFull],
  calendar_write: [SCOPES.calendarEvents, SCOPES.calendarFull],
  send: [SCOPES.send],
};

const MAIL_FEATURES: ReadonlySet<ConnectionFeature> = new Set(['drafts', 'organize', 'send']);

/** Every Gmail feature needs mail reading (drafts and rules work on synced threads). */
export function normalizeRequestedFeatures(features: readonly ConnectionFeature[]): ConnectionFeature[] {
  const set = new Set(features);
  if ([...set].some((feature) => MAIL_FEATURES.has(feature))) set.add('mail_read');
  if (set.has('calendar_write')) set.add('calendar_read');
  return CONNECTION_FEATURES.filter((feature) => set.has(feature));
}

export function scopesForFeatures(features: readonly ConnectionFeature[]): string[] {
  return [...IDENTITY_SCOPES, ...normalizeRequestedFeatures(features).map((feature) => FEATURE_SCOPE[feature])];
}

/** Features the granted scopes actually allow, limited to what the user asked for over time. */
export function grantedFeatures(grantedScopes: readonly string[], wanted: readonly ConnectionFeature[]): ConnectionFeature[] {
  const granted = new Set(grantedScopes);
  const wantedSet = new Set(normalizeRequestedFeatures(wanted));
  return CONNECTION_FEATURES.filter((feature) => wantedSet.has(feature) && SATISFIED_BY[feature].some((scope) => granted.has(scope)));
}

export function hasFeature(features: readonly string[], feature: ConnectionFeature): boolean {
  return features.includes(feature);
}

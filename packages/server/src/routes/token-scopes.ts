import type { RouteName } from '@pigeonbox/api-contract';
import type { Scope } from '../intel/api-tokens.js';

/**
 * Which contract routes a developer API token may call, and with which scope.
 * Anything not listed (sign-in, account, billing, connections, preferences,
 * rule and automation configuration, tokens, and deciding approvals) needs the
 * person's own session. A token can ask for an approval; it can never grant one.
 */
export const TOKEN_ROUTE_SCOPES: Partial<Record<RouteName, Scope>> = {
  connections: 'read',
  threadsIntel: 'read',
  focusQueue: 'read',
  followUps: 'read',
  draftGet: 'read',
  draftList: 'read',
  askPigeon: 'read',
  calendarAvailability: 'read',
  contacts: 'read',
  contactBrief: 'read',
  radar: 'read',
  threadSignals: 'read',
  views: 'read',
  viewResults: 'read',
  automations: 'read',
  automationRuns: 'read',
  approvals: 'read',
  auditList: 'read',
  notifications: 'read',
  briefings: 'read',
  briefingGet: 'read',
  documents: 'read',
  documentAnalytics: 'read',
  snippets: 'read',
  workspaces: 'read',
  threadTeam: 'read',
  draftPrepare: 'prepare',
  eventPrepare: 'prepare',
  schedulePropose: 'prepare',
  snippetRender: 'prepare',
  meetingBrief: 'prepare',
  briefingGenerate: 'prepare',
  draftPlace: 'write',
  eventCreate: 'write',
  threadStateUpdate: 'write',
  followUpUpdate: 'write',
  actionUndo: 'write',
  automationRun: 'write',
  assign: 'write',
  assignmentUpdate: 'write',
  commentAdd: 'write',
};

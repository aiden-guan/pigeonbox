import { describe, expect, it } from 'vitest';
import {
  AI_LIMITS,
  CapabilitiesResponseSchema,
  DraftRequestSchema,
  ERROR_STATUS,
  ErrorBodySchema,
  KNOWN_CAPABILITIES,
  PROTOCOL_VERSION,
  ROUTES,
  SessionResponseSchema,
  SummarizeRequestSchema,
  errorBody,
  isSupportedProtocol,
  knownCapabilities,
} from './index';

const voice = {
  name: 'Ada',
  about: '',
  greeting: 'Hi',
  signoff: 'Thanks',
  concision: 'medium',
  capitalization: 'normal',
  formality: 'neutral',
  emoji: false,
  schedulingPreference: '',
  personalInstructions: '',
} as const;

describe('api contract', () => {
  it('has one unique path per route and versions every path', () => {
    const keys = Object.values(ROUTES).map((route) => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const route of Object.values(ROUTES)) expect(route.path.startsWith('/v1/')).toBe(true);
  });

  it('marks every inference route as authenticated and metered', () => {
    for (const route of Object.values(ROUTES)) {
      if ('operation' in route) {
        expect(route.auth).toBe('user');
        expect(route.method).toBe('POST');
      }
    }
  });

  it('only exposes health, version and token exchange without auth', () => {
    const open = Object.entries(ROUTES)
      .filter(([, route]) => route.auth === 'none')
      .map(([name]) => name)
      .sort();
    expect(open).toEqual(['authRefresh', 'authToken', 'health', 'version']);
  });

  it('accepts a normal draft request and rejects oversized bodies', () => {
    const input = {
      subject: 'Lunch',
      messages: [{ sender: 'Dana <dana@example.com>', bodyText: 'Are you free Friday?', timestamp: '2026-09-01' }],
      voice,
      kind: 'reply' as const,
    };
    expect(DraftRequestSchema.safeParse({ input }).success).toBe(true);
    const huge = { ...input, messages: [{ ...input.messages[0], bodyText: 'x'.repeat(AI_LIMITS.bodyChars + 1) }] };
    expect(DraftRequestSchema.safeParse({ input: huge }).success).toBe(false);
  });

  it('rejects an empty thread for summaries', () => {
    expect(SummarizeRequestSchema.safeParse({ input: { subject: 's', messages: [] } }).success).toBe(false);
  });

  it('keeps unknown capabilities on the wire but drops them when typed', () => {
    const parsed = CapabilitiesResponseSchema.parse({ plan: 'cloud', capabilities: ['cloud_ai', 'teleport'] });
    expect(knownCapabilities(parsed.capabilities)).toEqual(['cloud_ai']);
    expect(KNOWN_CAPABILITIES).toContain('cloud_mcp');
  });

  it('gates every Cloud intelligence route behind a known capability and a signed-in user', () => {
    const known = new Set<string>(KNOWN_CAPABILITIES);
    for (const [name, route] of Object.entries(ROUTES)) {
      if (!('capability' in route)) continue;
      expect(known.has(route.capability as string), name).toBe(true);
      expect(route.auth, name).toBe('user');
      expect(route.capability, name).not.toBe('local_ai');
    }
    expect(ROUTES.connectStart.capability).toBe('cloud_mail_sync');
    expect(ROUTES.askPigeon.capability).toBe('cloud_semantic_search');
  });

  it('requires an idempotency key on every externally visible write', () => {
    for (const name of ['draftPlace', 'approvalDecide', 'actionUndo', 'eventCreate', 'automationRun'] as const) {
      const shape = (ROUTES[name].request as unknown as { shape: Record<string, unknown> }).shape;
      expect(shape.idempotencyKey, name).toBeDefined();
    }
  });

  it('keeps sending out of every route that could run without approval', () => {
    const paths = Object.values(ROUTES).map((route) => route.path);
    expect(paths.some((path) => /send/i.test(path))).toBe(false);
  });

  it('builds error bodies with fixed retryability', () => {
    const body = errorBody('provider_timeout', 'slow', { requestId: 'req_1' });
    expect(ErrorBodySchema.parse(body).error).toEqual({ code: 'provider_timeout', message: 'slow', retryable: true, requestId: 'req_1' });
    expect(errorBody('entitlement_required', 'no').error.retryable).toBe(false);
    expect(ERROR_STATUS.entitlement_required).toBe(402);
    expect(ERROR_STATUS.unsupported_protocol).toBe(426);
  });

  it('checks protocol versions strictly', () => {
    expect(isSupportedProtocol(String(PROTOCOL_VERSION), [PROTOCOL_VERSION])).toBe(true);
    expect(isSupportedProtocol('0', [PROTOCOL_VERSION])).toBe(false);
    expect(isSupportedProtocol('1.5', [1])).toBe(false);
    expect(isSupportedProtocol(null, [1])).toBe(false);
  });

  it('requires a complete session', () => {
    expect(SessionResponseSchema.safeParse({ accessToken: 'a'.repeat(20), refreshToken: 'r'.repeat(20), expiresAt: 1, user: { id: 'u', email: null } }).success).toBe(true);
    expect(SessionResponseSchema.safeParse({ accessToken: 'a'.repeat(20), expiresAt: 1, user: { id: 'u', email: null } }).success).toBe(false);
  });
});

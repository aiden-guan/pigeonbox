import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoutableMethod } from 'convex/server';
import type { ActionCtx } from './_generated/server';
import http from './http';

const origin = 'chrome-extension://njikfkbjpdikflognoaddcbhfhhfnbeh';
const token = 'test-only-personal-token';

function request(path: string, method: RoutableMethod, authenticated = false, body?: unknown, requestOrigin = origin) {
  const handler = http.lookup(path.split('?')[0], method)?.[0];
  if (!handler) throw new Error(`No route for ${method} ${path}`);
  const runQuery = vi.fn().mockResolvedValue(path === '/api/emails/trk_example' ? null : []);
  const runMutation = vi.fn();
  const invoke = (handler as unknown as { _handler: (ctx: ActionCtx, req: Request) => Promise<Response> })._handler;
  const response = invoke({ runQuery, runMutation } as unknown as ActionCtx, new Request(
    `https://energized-eagle-668.convex.site${path}`,
    {
      method,
      headers: {
        Origin: requestOrigin,
        ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
        ...(method === 'OPTIONS' ? {
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization,content-type',
        } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
  ));
  return { response, runQuery, runMutation };
}

describe('self-hosted tracker CORS', () => {
  beforeEach(() => vi.stubEnv('PERSONAL_API_TOKEN', token));
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    '/api/emails?limit=200',
    '/api/events/recent',
    '/api/emails/trk_example/events',
    '/api/emails/trk_example',
    '/api/emails/trk_example/self-view',
  ])('answers token-free preflight for %s without accessing data', async (path) => {
    const { response, runQuery, runMutation } = request(path, 'OPTIONS');
    const res = await response;
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, PATCH, OPTIONS');
    expect(res.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toBe('authorization, content-type');
    expect(res.headers.has('Access-Control-Allow-Credentials')).toBe(false);
    expect(runQuery).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
  });

  it.each(['/api/emails?limit=200', '/api/events/recent'])('makes authenticated %s responses readable', async (path) => {
    const { response, runQuery } = request(path, 'GET', true);
    const res = await response;
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual([]);
    expect(runQuery).toHaveBeenCalledOnce();
  });

  it.each([
    ['/api/emails', 'GET'],
    ['/api/events/recent', 'GET'],
    ['/api/emails', 'POST'],
    ['/api/emails/trk_example/self-view', 'POST'],
    ['/api/emails/trk_example', 'PATCH'],
  ] as const)('preserves authentication and exposes 401 for %s %s', async (path, method) => {
    const { response, runQuery, runMutation } = request(path, method);
    const res = await response;
    expect(res.status).toBe(401);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(runQuery).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
  });

  it('rejects data access when the personal token is not configured', async () => {
    vi.stubEnv('PERSONAL_API_TOKEN', '');
    const { response, runQuery } = request('/api/emails', 'GET', true);
    expect((await response).status).toBe(401);
    expect(runQuery).not.toHaveBeenCalled();
  });

  it.each([
    ['/api/missing', 'GET', undefined, 404],
    ['/api/emails/bad.id', 'GET', undefined, 400],
    ['/api/emails', 'POST', {}, 400],
    ['/api/emails/trk_example', 'PATCH', null, 400],
    ['/api/emails/trk_example', 'GET', undefined, 404],
  ] as const)('exposes API errors for %s %s', async (path, method, body, status) => {
    const { response } = request(path, method, true, body);
    const res = await response;
    expect(res.status).toBe(status);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
  });

  it.each(['https://example.com', 'null', 'chrome-extension://invalid', `${origin}.example.com`])('rejects preflight from %s', async (requestOrigin) => {
    const { response, runQuery, runMutation } = request('/api/emails', 'OPTIONS', false, undefined, requestOrigin);
    const res = await response;
    expect(res.status).toBe(403);
    expect(res.headers.has('Access-Control-Allow-Origin')).toBe(false);
    expect(runQuery).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
  });

  it('supports another valid unpacked extension ID', async () => {
    const anotherOrigin = `chrome-extension://${'a'.repeat(32)}`;
    const res = await request('/api/emails', 'OPTIONS', false, undefined, anotherOrigin).response;
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(anotherOrigin);
    expect(res.headers.get('Vary')).toBe('Origin');
  });
});

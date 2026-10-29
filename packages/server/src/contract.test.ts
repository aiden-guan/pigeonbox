import { KNOWN_CAPABILITIES, ROUTES } from '@pigeonbox/api-contract';
import { describe, expect, it } from 'vitest';
import { CAPABILITY_MESSAGES, HANDLED_ROUTES } from './api.js';
import { CONTROL_ROUTES } from './control/contract.js';
import { TOKEN_ROUTE_SCOPES } from './routes/token-scopes.js';

/** No dead buttons: every route the contract advertises is implemented, and nothing unadvertised is. */
describe('API contract', () => {
  const all = { ...ROUTES, ...CONTROL_ROUTES };

  it('has a handler for every route, and a route for every handler', () => {
    expect(Object.keys(all).filter((name) => !HANDLED_ROUTES.has(name))).toEqual([]);
    expect([...HANDLED_ROUTES].filter((name) => !(name in all))).toEqual([]);
  });

  it('has unique method + path pairs', () => {
    const keys = Object.values(all).map((route) => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('explains every capability gate in plain words', () => {
    const gated = new Set(Object.values(all).flatMap((route) => ('capability' in route && route.capability ? [route.capability] : [])));
    for (const capability of gated) {
      expect(KNOWN_CAPABILITIES, capability).toContain(capability);
      expect(CAPABILITY_MESSAGES[capability], capability).toBeTruthy();
    }
  });

  it('never lets API tokens administer the account, approve actions, bill, or manage connections', () => {
    // Listing connections is fine; starting, changing or removing them is not.
    const forbidden = /^(approvalDecide|account|billing|auth|connectStart|connection[A-Z]|preferencesUpdate|control)/;
    expect(Object.keys(TOKEN_ROUTE_SCOPES).filter((name) => forbidden.test(name))).toEqual([]);
    for (const name of Object.keys(TOKEN_ROUTE_SCOPES)) expect(all, name).toHaveProperty(name);
  });
});

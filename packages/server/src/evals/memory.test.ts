import type { PersonalMemory } from '@pigeonbox/api-contract';
import { describe, expect, it } from 'vitest';
import { createInferenceBackend } from '../ai/backends.js';
import { loadConfig } from '../config.js';
import { createIntelDeps } from '../intel/context.js';
import { getRelevantContext } from '../intel/memory/retrieve.js';
import { loadPreferences } from '../intel/preferences.js';
import { testEnv } from '../testing.js';
import { createIntelHarness, connectedUser, deliverAndSync } from '../testing/intel-harness.js';
import { MemoryFixtureAI } from '../testing/memory-fixtures.js';

const owner = 'ada@work.test';
const professor = 'professor@berkeley.test';
const live = process.env.PIGEONBOX_EVAL_LIVE === '1';
function liveEnv(): Record<string, string> {
  return {
    ...(Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key.startsWith('CLOUD_AI_') && typeof value === 'string')) as Record<
      string,
      string
    >),
    CLOUD_AI_TIMEOUT_MS: process.env.CLOUD_AI_TIMEOUT_MS ?? '60000',
  };
}
function backend() {
  if (!live) return new MemoryFixtureAI();
  const required = ['CLOUD_AI_PROVIDER', 'CLOUD_AI_BASE_URL', 'CLOUD_AI_API_KEY', 'CLOUD_AI_PRIMARY_MODEL'];
  if (required.some((key) => !process.env[key]) || process.env.CLOUD_AI_PROVIDER === 'mock')
    throw new Error('Live memory eval needs explicitly configured real inference.');
  return createInferenceBackend(loadConfig(testEnv(liveEnv())));
}
describe('memory scenario evals (real pipeline, synthetic communication)', () => {
  it(
    'recalls a recruiter follow-up request after the weekend through existing thread/relationship context',
    async () => {
      const inference = backend();
      const h = await createIntelHarness({ inference, env: live ? liveEnv() : {} });
      try {
        const user = await connectedUser(h, owner, ['mail_read'], { autoDrafts: { enabled: false } });
        const recruiter = 'sam@talentco.test';
        await deliverAndSync(h, owner, {
          from: recruiter,
          to: [owner],
          subject: 'Internship next steps',
          body: 'Please follow up after Friday about the internship.',
        });
        await h.advance(4 * 86_400_000);
        const deps = createIntelDeps({
          config: h.config,
          db: h.db,
          box: h.box,
          google: h.deps.intel!.google,
          inference,
          store: h.store,
          log: h.deps.log,
          now: h.now,
          fetch: h.google.fetch,
          storage: h.storage,
        });
        const prefs = await h.db.asUser(user.userId, (tx) => loadPreferences(tx, user.userId));
        const result = await getRelevantContext(deps, {
          userId: user.userId,
          recipientEmails: [recruiter],
          subject: 'Internship follow-up',
          now: h.now(),
          requestId: 'eval_recruiter',
          prefs,
        });
        expect(
          result
            .map((item) => item.text)
            .join('\n')
            .toLowerCase(),
        ).toContain('friday');
        expect(result.some((item) => item.recipientMatch && item.ref.kind === 'thread')).toBe(true);
      } finally {
        await h.pg.close();
      }
    },
    live ? 180_000 : 20_000,
  );
  it(
    'professor recall, updated date and privacy/noise exclusions',
    async () => {
      const inference = backend();
      const h = await createIntelHarness({ inference, env: live ? liveEnv() : {} });
      try {
        const user = await connectedUser(h, owner, ['mail_read'], { autoDrafts: { enabled: false } });
        const send = (body: string, subject: string, from = professor, headers?: Record<string, string>) =>
          deliverAndSync(h, owner, { from, to: [owner], subject, body, headers });
        await send('Midterm 2 covers through Chapter 8. Calculators are not allowed.', 'Midterm 2 Logistics');
        await send('Your verification code is 837291.', 'Security verification', 'security@service.test');
        await send('Sale ends Friday. Unsubscribe here.', 'Store newsletter', 'deals@store.test', { 'List-Unsubscribe': '<mailto:leave@store.test>' });
        await send('Unrelated course: reading on ancient history.', 'History seminar', 'teacher@history.test');
        const deps = createIntelDeps({
          config: h.config,
          db: h.db,
          box: h.box,
          google: h.deps.intel!.google,
          inference,
          store: h.store,
          log: h.deps.log,
          now: h.now,
          fetch: h.google.fetch,
          storage: h.storage,
        });
        const prefs = await h.db.asUser(user.userId, (tx) => loadPreferences(tx, user.userId));
        const context = async () =>
          getRelevantContext(deps, {
            userId: user.userId,
            recipientEmails: [professor],
            subject: 'Midterm 2 question',
            now: h.now(),
            requestId: 'eval_memory',
            prefs,
          });
        const exam = (await context())
          .map((item) => item.text)
          .join('\n')
          .toLowerCase();
        expect(exam).toContain('chapter 8');
        expect(exam).toMatch(/calculator/);
        expect(exam).not.toContain('ancient history');
        const memories = await h.route<{ memories: PersonalMemory[] }>('memoryList', user.token, { limit: 50 });
        expect(JSON.stringify(memories)).not.toMatch(/837291|Sale ends|unsubscribe/i);
        await send('Midterm 2 is October 14.', 'Midterm 2 Date');
        await h.advance(1_000);
        await send('Midterm 2 has been moved to October 16.', 'Midterm 2 updated date');
        const updated = (await context()).map((item) => item.text).join('\n');
        expect(updated).toContain('October 16');
        expect(updated).not.toContain('October 14');
      } finally {
        await h.pg.close();
      }
    },
    live ? 180_000 : 20_000,
  );
});

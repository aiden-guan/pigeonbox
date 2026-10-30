import { expect, it, vi } from 'vitest';
import { observedLogger, operationalReporter, safeSample } from './observability.js';
it('never serializes caller text, URLs, headers, IDs, errors, or mail into external reports', async () => {
  const send = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
  const report = operationalReporter({ endpoint: 'https://collector.test/events', fetch: send as typeof fetch });
  const log = observedLogger(vi.fn(), report);
  const privateText = 'secret@inbox.test body prompt oauth document-token';
  log('error', privateText, { route: '/d/secret-document-token?code=oauth', status: 500, userId: privateText, code: privateText });
  expect(safeSample(privateText, 1)).toBeNull();
  expect(safeSample('dead_jobs', privateText)).toBeNull();
  expect(safeSample('dead_jobs', Infinity)).toBeNull();
  await report.flush();
  const payload = String(send.mock.calls[0]![1]!.body);
  expect(JSON.parse(payload)).toEqual({ schema: 1, samples: [{ metric: 'worker_5xx', value: 1 }, { metric: 'tracking_endpoint_error', value: 1 }] });
  for (const secret of ['secret', 'oauth', 'document-token', 'inbox.test']) expect(payload).not.toContain(secret);
});
it('is inert without configuration, refuses unsafe collector URLs, and absorbs outages', async () => {
  const send = vi.fn(async () => { throw new Error('private upstream detail'); });
  for (const endpoint of [undefined, 'http://collector.test', 'https://u:p@collector.test', 'https://collector.test?token=secret']) {
    const report = operationalReporter({ endpoint, fetch: send }); report.metric('worker_5xx'); await report.flush();
  }
  expect(send).not.toHaveBeenCalled();
  const report = operationalReporter({ endpoint: 'https://collector.test/events', fetch: send }); report.metric('provider_error'); await expect(report.flush()).resolves.toBeUndefined();
});
it('reports tracking delivery lag, retries and exhausted attempts as numeric operational samples', async () => {
  const send=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>new Response(null,{status:204}));
  const report=operationalReporter({endpoint:'https://collector.test/events',fetch:send});
  const log=observedLogger(vi.fn(),report);
  log('info','tracking ingestion',{code:'tracking_ingested',lagMs:1200,count:1,attempts:2});
  log('error','tracking ingestion',{code:'tracking_dead_letter_pending',lagMs:3000,count:1,attempts:8});
  await report.flush();
  expect(JSON.parse(String(send.mock.calls[0][1]?.body)).samples).toEqual([
    {metric:'tracking_ingested',value:1},{metric:'tracking_ingest_lag_ms',value:1200},
    {metric:'tracking_dead_letter_pending',value:1},{metric:'tracking_ingest_lag_ms',value:3000},
  ]);
});

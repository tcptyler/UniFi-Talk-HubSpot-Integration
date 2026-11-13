import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { HubSpotClient, HubSpotAuthError, HubSpotError } from '../src/hubspot/client.ts';
import { startMockHubSpot, TOKEN, type MockHubSpot } from './helpers/mock-hubspot.ts';

let hs: MockHubSpot;
before(async () => {
  hs = await startMockHubSpot({ customMeetingOutcome: true });
});
after(() => hs.close());

const sleeps: number[] = [];
const client = (extra: Partial<ConstructorParameters<typeof HubSpotClient>[0]> = {}) =>
  new HubSpotClient({ token: TOKEN, baseUrl: hs.url, sleep: async (ms) => void sleeps.push(ms), ...extra });

test('reads account details, every page of owners, and call outcomes with the Service Key', async () => {
  const c = client();
  assert.equal((await c.accountDetails()).timeZone, 'America/New_York');
  assert.deepEqual((await c.owners()).map((o) => o.id), ['101', '102']);
  assert.equal((await c.callOutcomes()).length, 3);
  assert.ok(hs.requests.every((r) => r.auth === `Bearer ${TOKEN}`));
});

test('finds contacts by national number and calls by Talk id', async () => {
  const c = client();
  assert.deepEqual((await c.findContactsByPhone('+12025550123')).results.map((r) => r.id), ['501']);
  assert.equal((await c.findContactsByPhone('+12025550999')).results.length, 0);
  assert.equal(await c.findCallByTalkId('vm'), '9001');
  assert.equal(await c.findCallByTalkId('other'), null);
});

test('429 waits for Retry-After, then succeeds', async () => {
  let calls = 0;
  hs.route('GET', '/crm/owners/2026-09/429', () => (++calls === 1 ? { status: 429, headers: { 'Retry-After': '2' }, body: { message: 'slow down' } } : { body: { results: [] } }));
  sleeps.length = 0;
  await client().request('GET', '/crm/owners/2026-09/429', { schema: (await import('zod')).z.unknown() });
  assert.equal(calls, 2);
  assert.ok(sleeps.includes(2000), `slept ${sleeps.join(',')}`);
});

test('server errors: reads are retried, creates are not (no duplicate records)', async () => {
  const { z } = await import('zod');
  let gets = 0;
  hs.route('GET', '/flaky', () => (++gets < 3 ? { status: 503, body: {} } : { body: { ok: true } }));
  await client().request('GET', '/flaky', { schema: z.unknown() });
  assert.equal(gets, 3);
  let posts = 0;
  hs.route('POST', '/crm/objects/2026-09/calls', () => (++posts, { status: 502, body: { message: 'bad gateway' } }));
  await assert.rejects(client().request('POST', '/crm/objects/2026-09/calls', { body: {}, schema: z.unknown() }), (e: unknown) => e instanceof HubSpotError && e.status === 502);
  assert.equal(posts, 1);
});

test('auth and scope errors are explained', async () => {
  await assert.rejects(client({ token: 'wrong' }).accountDetails(), (e: unknown) => e instanceof HubSpotAuthError && e.status === 401 && /HUBSPOT_TOKEN/.test(e.message));
  hs.route('GET', '/calling/v1/dispositions', () => ({ status: 403, body: { message: "This app hasn't been granted all required scopes", category: 'MISSING_SCOPES' } }));
  await assert.rejects(client().callOutcomes(), (e: unknown) => e instanceof HubSpotAuthError && e.category === 'MISSING_SCOPES' && /lacks a scope/.test(e.message));
});

test('searches stay under 5 per second', async () => {
  let clock = 0;
  sleeps.length = 0;
  const c = client({ now: () => clock, sleep: async (ms) => void (sleeps.push(ms), (clock += ms)) });
  for (let i = 0; i < 5; i++) await c.findCallByTalkId(`x${i}`);
  assert.deepEqual(sleeps, [1000], 'the fifth search in the same second waits');
});

test('a success that is not JSON is an error, not a crash', async () => {
  hs.route('GET', '/not-json', () => ({ body: '<html>oops</html>' }));
  const { z } = await import('zod');
  await assert.rejects(client().request('GET', '/not-json', { schema: z.unknown() }), /not JSON/);
});

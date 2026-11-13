import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  TalkClient,
  TalkAuthError,
  TalkRateLimitError,
  TalkSchemaError,
  parseRetryAfter,
  readSessionToken,
  type TalkAuth,
} from '../src/talk/client.ts';
import { fetchCertificate, normalizeFingerprint } from '../src/talk/tls.ts';
import { startMockConsole, callRecord, jwt, type MockConsole } from './helpers/mock-console.ts';

const USER = 'integration';
const PASS = 'correct horse battery staple';
const API_KEY = 'test-api-key';
const SESSION = jwt({ csrfToken: 'csrf-from-jwt', exp: 4102444800, isRemembered: true });

let mock: MockConsole;

const client = (auth: TalkAuth, pin = mock.pin) =>
  new TalkClient({ host: '127.0.0.1', port: mock.port, pin, auth, minIntervalMs: 0, requestTimeoutMs: 5_000 });

before(async () => {
  mock = await startMockConsole({ username: USER, password: PASS, apiKey: API_KEY, sessionToken: SESSION });
  mock.route('info', () => ({ body: { version: '5.4.8', update_channel: 'beta', host_device_model: 'MOCK' } }));
  mock.route('call_log', (url) => ({
    body: {
      records: [callRecord({ events: [[0, 'call_received'], [5, 'call_accepted'], [65, 'call_hangup', { hangup_cause: 'normal_end' }]] })],
      total_count: '1',
      echo: Object.fromEntries(url.searchParams),
    },
  }));
  mock.route('transcript/by_call_uuid', (url) =>
    url.searchParams.get('call_uuid') === 'has-transcript'
      ? { body: { status: 'completed', analytics: { summary: 'Short summary.', lines: [{ speaker: 'speaker_0', line: 'Hello.' }] } } }
      : { body: 'null' },
  );
  mock.route('sms/conversation/*', () => ({
    body: {
      messages: [
        {
          sid: 'SM1',
          status: 'delivered',
          created_at: '2026-11-12T20:00:00Z',
          from_number: '+12025550100',
          to_number: '+12025550199',
          msg_data: { direction: 'in', text: 'Synthetic message', fromNumber: '+12025550100', toNumber: '+12025550199' },
        },
      ],
    },
  }));
  mock.route('users', () => ({ body: [{ unique_id: 'u1', first_name: 42 }] })); // drifted shape on purpose
});

after(() => mock.close());

describe('TLS pinning', () => {
  test('fetchCertificate reports the same fingerprint the server uses', async () => {
    const cert = await fetchCertificate('127.0.0.1', mock.port);
    assert.equal(cert.sha256, mock.pin);
    assert.equal(cert.selfSigned, true);
  });

  test('a mismatched pin refuses the connection before anything is sent', async () => {
    const before = mock.requests.length;
    const wrong = 'ab'.repeat(32);
    await assert.rejects(client({ kind: 'apiKey', apiKey: API_KEY }, wrong).info(), /does not match the pinned fingerprint/);
    assert.equal(mock.requests.length, before, 'no request reached the server');
  });

  test('pins are normalised (colons and case)', () => {
    assert.equal(normalizeFingerprint('AB:CD:ef'), 'abcdef');
    assert.throws(() => new TalkClient({ host: 'x', pin: 'abc', auth: { kind: 'apiKey', apiKey: 'k' } }), /64 hex/);
  });
});

describe('sign-in', () => {
  test('API key goes in X-API-Key and no cookie is sent', async () => {
    const info = await client({ kind: 'apiKey', apiKey: API_KEY }).info();
    assert.equal(info.version, '5.4.8');
    const req = mock.requests.at(-1)!;
    assert.equal(req.headers['x-api-key'], API_KEY);
    assert.equal(req.headers.cookie, undefined);
  });

  test('a refused API key is a TalkAuthError', async () => {
    await assert.rejects(client({ kind: 'apiKey', apiKey: 'nope' }).info(), (e: unknown) => e instanceof TalkAuthError && /API key/.test(e.message));
  });

  test('local account signs in once and sends the cookie and CSRF token', async () => {
    const c = client({ kind: 'localAccount', username: USER, password: PASS });
    const loginsBefore = mock.logins;
    await c.info();
    await c.info();
    assert.equal(mock.logins - loginsBefore, 1, 'one sign-in for two requests');
    const req = mock.requests.at(-1)!;
    assert.match(String(req.headers.cookie), /^TOKEN=/);
    assert.match(String(req.headers['x-csrf-token']), /^csrf-\d+$/);
  });

  test('parallel first requests share one sign-in', async () => {
    const c = client({ kind: 'localAccount', username: USER, password: PASS });
    const loginsBefore = mock.logins;
    await Promise.all([c.info(), c.info(), c.info()]);
    assert.equal(mock.logins - loginsBefore, 1);
  });

  test('an expired session signs in again once and retries', async () => {
    const c = client({ kind: 'localAccount', username: USER, password: PASS });
    await c.info();
    mock.expireSessions();
    const loginsBefore = mock.logins;
    const info = await c.info();
    assert.equal(info.version, '5.4.8');
    assert.equal(mock.logins - loginsBefore, 1);
  });

  test('a wrong password fails and blocks further sign-in attempts', async () => {
    const c = client({ kind: 'localAccount', username: USER, password: 'wrong' });
    await assert.rejects(c.info(), (e: unknown) => e instanceof TalkAuthError && /sign-in refused/.test(e.message));
    const loginsBefore = mock.logins;
    await assert.rejects(c.info(), TalkRateLimitError);
    assert.equal(mock.logins, loginsBefore, 'no second sign-in attempt');
  });

  test('session token: CSRF token comes from the JWT', async () => {
    await client({ kind: 'sessionToken', token: SESSION }).info();
    const req = mock.requests.at(-1)!;
    assert.equal(req.headers.cookie, `TOKEN=${SESSION}`);
    assert.equal(req.headers['x-csrf-token'], 'csrf-from-jwt');
  });

  test('session token: an expired token is a TalkAuthError, not a retry loop', async () => {
    const stale = jwt({ csrfToken: 'x', exp: 1 });
    const before = mock.requests.length;
    await assert.rejects(client({ kind: 'sessionToken', token: stale }).info(), (e: unknown) => e instanceof TalkAuthError && /session token/.test(e.message));
    assert.equal(mock.requests.length - before, 1);
  });

  test('readSessionToken reads claims and tolerates junk', () => {
    const claims = readSessionToken(SESSION);
    assert.equal(claims.csrfToken, 'csrf-from-jwt');
    assert.equal(claims.remembered, true);
    assert.equal(claims.expiresAt?.getUTCFullYear(), 2100);
    assert.deepEqual(readSessionToken('not-a-jwt'), {});
  });
});

describe('rate limiting', () => {
  test('429 honours Retry-After and sends nothing until then', async () => {
    const c = client({ kind: 'apiKey', apiKey: API_KEY });
    mock.rateLimitNext(120);
    await assert.rejects(c.info(), (e: unknown) => {
      assert.ok(e instanceof TalkRateLimitError);
      const wait = e.retryAt.getTime() - Date.now();
      assert.ok(wait > 100_000 && wait <= 120_000, `retry in ~120 s, got ${wait} ms`);
      return true;
    });
    const before = mock.requests.length;
    await assert.rejects(c.info(), TalkRateLimitError);
    assert.equal(mock.requests.length, before);
  });

  test('parseRetryAfter handles seconds, dates and junk', () => {
    assert.equal(parseRetryAfter('30'), 30_000);
    assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6_000);
    assert.equal(parseRetryAfter('soon'), undefined);
    assert.equal(parseRetryAfter(undefined), undefined);
  });
});

describe('reads', () => {
  test('callLogPage sends millisecond time filters and parses records', async () => {
    const page = await client({ kind: 'apiKey', apiKey: API_KEY }).callLogPage({ fromMs: 1_700_000_000_123.7, toMs: 1_700_000_100_000, itemsPerPage: 50 });
    assert.equal(page.total_count, 1);
    assert.equal(page.records.length, 1);
    const echo = (page as unknown as { echo: Record<string, string> }).echo;
    assert.equal(echo.from_time, '1700000000123');
    assert.equal(echo.to_time, '1700000100000');
    assert.equal(echo.items_per_page, '50');
    assert.equal(echo.sort_order, 'desc');
  });

  test('transcriptForCall returns null for a literal null and parses a transcript', async () => {
    const c = client({ kind: 'apiKey', apiKey: API_KEY });
    assert.equal(await c.transcriptForCall('no-transcript'), null);
    const t = await c.transcriptForCall('has-transcript');
    assert.equal(t?.analytics?.summary, 'Short summary.');
    assert.equal(t?.analytics?.lines[0]?.line, 'Hello.');
  });

  test('smsMessages unwraps { messages: [...] }', async () => {
    const msgs = await client({ kind: 'apiKey', apiKey: API_KEY }).smsMessages(7);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]?.msg_data.direction, 'in');
  });

  test('recording returns null on 404', async () => {
    assert.equal(await client({ kind: 'apiKey', apiKey: API_KEY }).recording('missing'), null);
  });

  test('schema drift is reported with paths only, never values', async () => {
    await assert.rejects(client({ kind: 'apiKey', apiKey: API_KEY }).users(), (e: unknown) => {
      assert.ok(e instanceof TalkSchemaError);
      assert.equal(e.path, 'users');
      assert.ok(e.issues.some((i) => i.startsWith('0.first_name')));
      assert.ok(!e.message.includes('42'), 'the offending value is not echoed');
      return true;
    });
  });
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCli as run } from './helpers/run-cli.ts';
import { startMockConsole, callRecord, type MockConsole } from './helpers/mock-console.ts';

let mock: MockConsole;

before(async () => {
  mock = await startMockConsole({ apiKey: 'cli-key' });
  mock.route('info', () => ({ body: { version: '5.4.8', update_channel: 'release' } }));
  mock.route('users', () => ({ body: [{ unique_id: 'u1', first_name: 'Test', last_name: 'User' }] }));
  mock.route('number/list', () => ({ body: [{ did: '+12025550199', sms_enabled: true }, { did: '+12025550198', sms_enabled: false }] }));
  mock.route('call_log', () => ({
    body: {
      records: [
        callRecord({ direction: 'in', from: '+12025550100', events: [[0, 'call_received'], [9, 'call_hangup']] }),
        callRecord({ direction: null, from: '201', to: '202', events: [[0, 'call_placed'], [4, 'call_hangup']] }),
      ],
      total_count: 2,
    },
  }));
});

after(() => mock.close());

test('check connects, summarises, and prints no phone numbers or names', async () => {
  const { code, text } = await run(['check'], {
    TALK_HOST: '127.0.0.1',
    TALK_PORT: String(mock.port),
    TALK_CERT_SHA256: mock.pin,
    TALK_API_KEY: 'cli-key',
    CONFIG_FILE: '',
  });
  assert.equal(code, 0, text);
  assert.match(text, /Talk version 5\.4\.8/);
  assert.match(text, /1 Talk users, 2 numbers \(1 with SMS\)/);
  assert.match(text, /2 calls/);
  assert.match(text, /1 of the latest 2 are external/);
  assert.match(text, /mode: dry run/);
  assert.doesNotMatch(text, /\+1202|555|Test User|cli-key/);
});

test('check with a wrong API key exits with the auth code', async () => {
  const { code, text } = await run(['check'], {
    TALK_HOST: '127.0.0.1',
    TALK_PORT: String(mock.port),
    TALK_CERT_SHA256: mock.pin,
    TALK_API_KEY: 'wrong',
  });
  assert.equal(code, 77);
  assert.match(text, /refused the API key/);
});

test('fingerprint prints the pin line for .env', async () => {
  const { code, text } = await run(['fingerprint', `127.0.0.1:${mock.port}`], {});
  assert.equal(code, 0);
  assert.ok(text.includes(`TALK_CERT_SHA256=${mock.pin}`));
});

test('unknown commands show usage', async () => {
  const { code } = await run(['frobnicate'], {});
  assert.equal(code, 64);
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from './helpers/run-cli.ts';
import { startMockConsole, callRecord, type MockConsole } from './helpers/mock-console.ts';
import { startMockHubSpot, TOKEN } from './helpers/mock-hubspot.ts';

let mock: MockConsole;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uth-preview-'));
const answered = (talk: number): Array<[number, string, Record<string, unknown>?]> => [[0, 'call_started'], [6, 'call_accepted'], [6 + talk, 'call_hangup', { hangup_cause: 'normal_end' }]];

before(async () => {
  mock = await startMockConsole({ apiKey: 'preview-key' });
  mock.route('info', () => ({ body: { version: '5.4.8', default_country: 'US' } }));
  mock.route('users', () => ({ body: [{ unique_id: 'user-alex', first_name: 'Alex', last_name: 'Rivera', email: 'alex@northwind.example' }] }));
  mock.route('number/list', () => ({ body: [{ did: '+12025550111', sms_enabled: true }] }));
  mock.route('call_log', () => ({
    body: {
      records: [
        callRecord({ uuid: 'vm', direction: 'out', from: '201', from_did: '+12025550111', from_id: 'user-alex', to: '+12025550123', events: answered(40) }),
        callRecord({ uuid: 'busy', direction: 'out', from: '201', from_id: 'user-alex', to: '+12025550124', events: [[0, 'call_started'], [2, 'call_hangup', { hangup_cause: 'refused' }]] }),
        callRecord({ uuid: 'int', direction: null, from: '201', to: '202', events: answered(10) }),
        callRecord({ uuid: 'broken', direction: 'in', from: '+12025550125', to: '+12025550111', answered_by_user_uuid: 'user-alex', events: answered(90) }),
      ],
      total_count: 4,
    },
  }));
  mock.route('transcript/by_call_uuid', (url) => {
    const id = url.searchParams.get('call_uuid');
    if (id === 'broken') return { status: 500, body: { error: 'oops' } };
    if (id !== 'vm') return { body: 'null' };
    return {
      body: {
        status: 'COMPLETED',
        analytics: {
          lines: [
            { speaker: 'speaker_0', line: "You've reached Jordan Smith with Smith Realty. Please leave a message after the tone.", line_start_time: 0, line_end_time: 6 },
            { speaker: 'speaker_1', line: 'Hi Jordan, this is Alex from Northwind Networks, calling about the office network. Call me back when you can.', line_start_time: 8, line_end_time: 16 },
          ],
        },
      },
    };
  });
});

after(() => mock.close());

test('preview plans every call, prints a shareable summary and writes the private plan', async () => {
  const { code, text } = await runCli(['preview', '--hours', '100000'], {
    TALK_HOST: '127.0.0.1',
    TALK_PORT: String(mock.port),
    TALK_CERT_SHA256: mock.pin,
    TALK_API_KEY: 'preview-key',
    DATA_DIR: dataDir,
    TIME_ZONE: 'America/New_York',
    COMPANY_NAMES: 'Northwind Networks',
    CONFIG_FILE: '',
  });
  assert.equal(code, 0, text);
  assert.match(text, /Nothing was written to HubSpot/);
  assert.match(text, /Left voicemail/);
  assert.match(text, /Busy/);
  assert.match(text, /\(skipped\)/);
  assert.match(text, /Would log 3 calls \(.*\) and create 3 review tasks\./);
  assert.match(text, /1 transcript could not be read; that call was planned from call events only/);
  assert.doesNotMatch(text, /555|Jordan|Smith|Alex|northwind/i, 'no numbers or names in the terminal summary');

  const file = /Full plan, with the exact HubSpot requests: (.+)$/m.exec(text)?.[1] ?? '';
  assert.ok(file.startsWith(dataDir), file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const plans = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { uuid: string; outcome: string | null; requests: unknown[] });
  assert.deepEqual(plans.map((p) => [p.uuid, p.outcome]), [
    ['broken', 'Connected'],
    ['int', null],
    ['busy', 'Busy'],
    ['vm', 'Left voicemail'],
  ]);
  assert.equal(plans.find((p) => p.uuid === 'vm')?.requests.length, 3);
});

test('with a HubSpot key: read-only matches, owners, already-logged calls, custom outcome and portal time zone', async () => {
  const hs = await startMockHubSpot({ customMeetingOutcome: true });
  try {
    const { code, text } = await runCli(['preview', '--hours', '100000'], {
      TALK_HOST: '127.0.0.1',
      TALK_PORT: String(mock.port),
      TALK_CERT_SHA256: mock.pin,
      TALK_API_KEY: 'preview-key',
      DATA_DIR: dataDir,
      HUBSPOT_TOKEN: TOKEN,
      HUBSPOT_API_BASE: hs.url,
      CONFIG_FILE: '',
    });
    assert.equal(code, 0, text);
    assert.match(text, /HubSpot \(read only, portal 1234567\): 1 of 3 caller numbers match a contact; 2 would be new contacts\./);
    assert.match(text, /Owners: talk user 3\. Already logged in HubSpot: 1\./);
    assert.match(text, /Custom outcome "Meeting booked" found/);
    assert.match(text, /11\/12, 3:15 PM/, "times shown in the portal's time zone when TIME_ZONE is not set");
    assert.ok(hs.requests.every((r) => r.method === 'GET' || r.path.endsWith('/search')), 'nothing but reads and searches');
    const file = /Full plan, with the exact HubSpot requests: (.+)$/m.exec(text)?.[1] ?? '';
    const vm = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((p) => p.uuid === 'vm');
    assert.deepEqual(vm.hubspot, { contactIds: ['501'], ownerId: '101', ownerSource: 'talk user', existingCallId: '9001' });
  } finally {
    await hs.close();
  }
});

test('with a wrong HubSpot key the Talk preview still runs and says why lookups were skipped', async () => {
  const hs = await startMockHubSpot();
  try {
    const { code, text } = await runCli(['preview', '--hours', '100000'], {
      TALK_HOST: '127.0.0.1',
      TALK_PORT: String(mock.port),
      TALK_CERT_SHA256: mock.pin,
      TALK_API_KEY: 'preview-key',
      DATA_DIR: dataDir,
      HUBSPOT_TOKEN: 'wrong',
      HUBSPOT_API_BASE: hs.url,
      CONFIG_FILE: '',
    });
    assert.equal(code, 0, text);
    assert.match(text, /HubSpot: HubSpot refused the Service Key \(check HUBSPOT_TOKEN\)\. Contacts and owners were not looked up\./);
    assert.match(text, /Would log 3 calls/);
  } finally {
    await hs.close();
  }
});

test('preview rejects bad options', async () => {
  const { code } = await runCli(['preview', '--hours', 'soon'], {});
  assert.equal(code, 64);
});

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { loadRules } from '../src/rules/rules.ts';
import { TalkClient, TalkSchemaError } from '../src/talk/client.ts';
import { HubSpotAuthError, HubSpotClient } from '../src/hubspot/client.ts';
import { loadHubSpotContext } from '../src/hubspot/lookup.ts';
import { Syncer, type Log } from '../src/sync/run.ts';
import { Store, pickSessionToken, saveSessionToken } from '../src/sync/store.ts';
import { startMockConsole, callRecord, jwt, at, type MockConsole } from './helpers/mock-console.ts';
import { startMockHubSpot, TOKEN, type MockHubSpot } from './helpers/mock-hubspot.ts';

// Made-up data. Calls happen around T0 (2026-11-12 20:15 UTC); each pass runs "30 minutes later".
const T0 = Date.parse(at(0));
const NOW = T0 + 30 * 60_000;
type Ev = [number, string, Record<string, unknown>?];
const answered = (start: number, talk: number): Ev[] => [[start, 'call_started'], [start + 6, 'call_accepted'], [start + 6 + talk, 'call_hangup', { hangup_cause: 'normal_end' }]];

let mock: MockConsole;
let hs: MockHubSpot;
let records: unknown[] = [];
const transcripts = new Map<string, unknown>();

before(async () => {
  mock = await startMockConsole({ apiKey: 'run-key' });
  mock.route('info', () => ({ body: { version: '5.4.8', default_country: 'US' } }));
  mock.route('users', () => ({ body: [{ unique_id: 'user-alex', first_name: 'Alex', email: 'alex@northwind.example' }] }));
  mock.route('number/list', () => ({ body: [{ did: '+12025550111' }] }));
  mock.route('call_log', () => ({ body: { records, total_count: records.length } }));
  mock.route('transcript/by_call_uuid', (url) => ({ body: transcripts.get(url.searchParams.get('call_uuid') ?? '') ?? 'null' }));
  hs = await startMockHubSpot();
});
after(async () => {
  await mock.close();
  await hs.close();
});

const logs: Array<[string, object, string | undefined]> = [];
const log: Log = { info: (o, m) => void logs.push(['info', o, m]), warn: (o, m) => void logs.push(['warn', o, m]), error: (o, m) => void logs.push(['error', o, m]) };

function setup(extraEnv: Record<string, string> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uth-run-'));
  const config = loadConfig({
    env: { TALK_HOST: '127.0.0.1', TALK_PORT: String(mock.port), TALK_CERT_SHA256: mock.pin, TALK_API_KEY: 'run-key', DATA_DIR: dataDir, TIME_ZONE: 'America/New_York', BACKFILL_HOURS: '1', ...extraEnv },
    cwd: dataDir,
  });
  const talk = new TalkClient({ host: '127.0.0.1', port: mock.port, pin: mock.pin, auth: config.talk.auth, minIntervalMs: 0 });
  return { dataDir, config, talk, store: Store.open(dataDir) };
}

const standardCalls = () => [
  callRecord({ uuid: 'out-1', direction: 'out', from: '201', from_did: '+12025550111', from_id: 'user-alex', to: '+12025550123', events: [[0, 'call_started'], [2, 'call_hangup', { hangup_cause: 'refused' }]] }),
  callRecord({ uuid: 'int-1', direction: null, from: '201', to: '202', events: answered(60, 10) }),
  callRecord({ uuid: 'spam-1', direction: 'in', from: '+12025550188', to: '+12025550111', events: [[120, 'call_started'], [140, 'call_hangup', { hangup_cause: 'cancelled' }]] }),
];

describe('dry run', () => {
  test('without a HubSpot key: records what would be sent, once', async () => {
    records = standardCalls();
    const { dataDir, config, talk } = setup({ DRY_RUN: 'true' });
    const syncer = new Syncer({ talk, config, rules: loadRules(), store: Store.open(dataDir), hubspot: null, log });
    const first = await syncer.once(NOW);
    assert.deepEqual([first.logged, first.skipped], [2, 1], 'two external calls planned, the internal one skipped');
    const file = path.join(dataDir, 'dry-run-2026-11-12.jsonl');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 3);
    const second = await syncer.once(NOW + 60_000);
    assert.deepEqual([second.logged, second.skipped], [0, 0], 'nothing repeated');
    assert.equal(fs.statSync(path.join(dataDir, 'state.json')).mode & 0o777, 0o600);
    talk.agent.destroy();
  });
});

describe('write mode', () => {
  test('logs each call once, applies the spam guard, and survives a restart', async () => {
    records = standardCalls();
    const { dataDir, config, talk } = setup({ DRY_RUN: 'false', HUBSPOT_TOKEN: TOKEN });
    const client = new HubSpotClient({ token: TOKEN, baseUrl: hs.url, searchesPerSecond: 100 });
    const hubspot = { client, context: await loadHubSpotContext(client) };
    const posts = () => hs.requests.filter((r) => r.method === 'POST' && r.path === '/crm/objects/2026-09/calls').length;
    const before = posts();
    const s1 = await new Syncer({ talk, config, rules: loadRules(), store: Store.open(dataDir), hubspot, log }).once(NOW);
    assert.equal(s1.logged, 1, 'the dialled call');
    assert.equal(s1.skipped, 2, 'internal call, and the unknown caller under the spam guard');
    assert.equal(posts() - before, 1);
    // A restart reads the saved progress: nothing is logged twice.
    const s2 = await new Syncer({ talk, config, rules: loadRules(), store: Store.open(dataDir), hubspot, log }).once(NOW + 60_000);
    assert.equal(s2.logged, 0);
    assert.equal(posts() - before, 1);
    talk.agent.destroy();
  });

  test('waits for the transcript, then logs without it if it never comes', async () => {
    const start = 28 * 60; // ended about a minute before NOW
    records = [callRecord({ uuid: 'wait-1', time: at(start), direction: 'out', from: '201', from_id: 'user-alex', to: '+12025550123', events: answered(start, 50) })];
    const { dataDir, config, talk } = setup({ DRY_RUN: 'false', HUBSPOT_TOKEN: TOKEN });
    const client = new HubSpotClient({ token: TOKEN, baseUrl: hs.url, searchesPerSecond: 100 });
    const syncer = new Syncer({ talk, config, rules: loadRules(), store: Store.open(dataDir), hubspot: { client, context: await loadHubSpotContext(client) }, log });
    transcripts.set('wait-1', { status: 'IN_PROGRESS', analytics: { lines: [] } });
    const s1 = await syncer.once(NOW);
    assert.deepEqual([s1.waiting, s1.logged], [1, 0]);
    const s2 = await syncer.once(NOW + 6 * 60_000);
    assert.deepEqual([s2.waiting, s2.logged], [0, 1], 'logged after the 5-minute wait');
    transcripts.delete('wait-1');
    talk.agent.destroy();
  });

  test('a failed call is retried on the next pass', async () => {
    records = [callRecord({ uuid: 'retry-1', direction: 'out', from: '201', from_id: 'user-alex', to: '+12025550123', events: [[0, 'call_started'], [2, 'call_hangup', { hangup_cause: 'refused' }]] })];
    let fail = true;
    hs.route('POST', '/crm/objects/2026-09/calls', () => (fail ? ((fail = false), { status: 400, body: { message: 'Property values were not valid' } }) : { status: 201, body: { id: '8800' } }));
    const { dataDir, config, talk } = setup({ DRY_RUN: 'false', HUBSPOT_TOKEN: TOKEN });
    const client = new HubSpotClient({ token: TOKEN, baseUrl: hs.url, searchesPerSecond: 100 });
    const syncer = new Syncer({ talk, config, rules: loadRules(), store: Store.open(dataDir), hubspot: { client, context: await loadHubSpotContext(client) }, log });
    assert.equal((await syncer.once(NOW)).failed, 1);
    assert.ok(logs.some(([level, o]) => level === 'error' && (o as { call?: string }).call === 'retry-1'));
    assert.equal((await syncer.once(NOW + 60_000)).logged, 1);
    talk.agent.destroy();
  });

  test('a refused HubSpot key stops the sync', async () => {
    records = standardCalls();
    const { dataDir, config, talk } = setup({ DRY_RUN: 'false', HUBSPOT_TOKEN: TOKEN });
    const good = new HubSpotClient({ token: TOKEN, baseUrl: hs.url });
    const revoked = new HubSpotClient({ token: 'revoked', baseUrl: hs.url });
    const syncer = new Syncer({ talk, config, rules: loadRules(), store: Store.open(dataDir), hubspot: { client: revoked, context: await loadHubSpotContext(good) }, log });
    await assert.rejects(syncer.once(NOW), HubSpotAuthError);
    talk.agent.destroy();
  });
});

describe('browser session kept across restarts', () => {
  test('the session the console renewed is saved privately and preferred while it lasts longer', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uth-session-'));
    const configured = jwt({ csrfToken: 'a', exp: 2_000_000_000 });
    assert.equal(pickSessionToken(dataDir, configured), configured, 'nothing saved yet');
    const renewed = jwt({ csrfToken: 'b', exp: 2_000_100_000 });
    saveSessionToken(dataDir, renewed);
    assert.equal(fs.statSync(path.join(dataDir, 'talk-session')).mode & 0o777, 0o600);
    assert.equal(pickSessionToken(dataDir, configured), renewed);
    const fresher = jwt({ csrfToken: 'c', exp: 2_000_200_000 });
    assert.equal(pickSessionToken(dataDir, fresher), fresher, 'a newer sign-in in the settings wins');
  });

  test('the Talk client reports a renewed session cookie', async () => {
    const token = jwt({ csrfToken: 'x', exp: 4102444800 });
    const console2 = await startMockConsole({ sessionToken: token });
    const renewedToken = jwt({ csrfToken: 'y', exp: 4102444900 });
    console2.route('info', () => ({ body: { version: '5.4.8' }, headers: { 'Set-Cookie': `TOKEN=${renewedToken}; Path=/; HttpOnly` } }));
    const seen: string[] = [];
    const talk = new TalkClient({ host: '127.0.0.1', port: console2.port, pin: console2.pin, auth: { kind: 'sessionToken', token }, onSessionToken: (t) => void seen.push(t) });
    await talk.info();
    assert.deepEqual(seen, [renewedToken]);
    talk.agent.destroy();
    await console2.close();
  });
});

test('schema drift in Talk stops the sync instead of logging bad data', async () => {
  records = [{ uuid: 42 }];
  const { dataDir, config, talk } = setup({ DRY_RUN: 'true' });
  await assert.rejects(new Syncer({ talk, config, rules: loadRules(), store: Store.open(dataDir), hubspot: null, log }).once(NOW), TalkSchemaError);
  talk.agent.destroy();
});

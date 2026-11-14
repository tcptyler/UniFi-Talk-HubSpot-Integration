import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CallRecord, TalkUser, Transcript } from '../src/talk/schemas.ts';
import { loadRules } from '../src/rules/rules.ts';
import { planCall, selfFromTalk, type PlanContext } from '../src/sync/plan.ts';
import { executePlan, hubspotWriter, recordingWriter, contactFields, type ExecuteOptions } from '../src/sync/execute.ts';
import { HubSpotClient } from '../src/hubspot/client.ts';
import { loadHubSpotContext, type HubSpotContext } from '../src/hubspot/lookup.ts';
import { callRecord } from './helpers/mock-console.ts';
import { startMockHubSpot, TOKEN, type MockHubSpot } from './helpers/mock-hubspot.ts';

// Made-up data. We are Alex at Northwind Networks; Alex is HubSpot owner 101 in the mock portal.
const users = [TalkUser.parse({ unique_id: 'user-alex', first_name: 'Alex', email: 'alex@northwind.example' })];
const ctx: PlanContext = {
  rules: loadRules(),
  self: selfFromTalk(users, [{ did: '+12025550111' }], ['Northwind Networks'], 'US'),
  users: new Map(users.map((u) => [u.unique_id, u])),
  talkUrl: 'https://192.0.2.10/talk/',
  talkSummary: true,
  country: 'US',
  timeZone: 'America/New_York',
  now: Date.parse('2026-11-12T21:00:00Z'),
};
const options: ExecuteOptions = { autoFill: 'new-and-existing', minTalkSecondsForNewContact: 30 };

type Ev = [number, string, Record<string, unknown>?];
const answered = (talk: number): Ev[] => [[0, 'call_started'], [6, 'call_accepted'], [6 + talk, 'call_hangup', { hangup_cause: 'normal_end' }]];
const rec = (o: Record<string, unknown> & { events: Ev[] }) => CallRecord.parse(callRecord(o));
const tr = (lines: Array<[string, string, number, number]>) =>
  Transcript.parse({ status: 'COMPLETED', analytics: { lines: lines.map(([speaker, line, s, e]) => ({ speaker, line, line_start_time: s, line_end_time: e })) } });
const voicemail = tr([
  ['speaker_0', "Hi, you've reached Bob Jones with Jones Plumbing. Please leave a message after the tone.", 0, 6],
  ['speaker_1', 'Hi Bob, this is Alex from Northwind Networks, following up on your quote. Call me back when you can, thanks.', 8, 18],
]);
const outbound = (uuid: string, to: string, events: Ev[]) => rec({ uuid, direction: 'out', from: '201', from_did: '+12025550111', from_id: 'user-alex', to, events });

let hs: MockHubSpot;
let client: HubSpotClient;
let context: HubSpotContext;
before(async () => {
  hs = await startMockHubSpot();
  client = new HubSpotClient({ token: TOKEN, baseUrl: hs.url, searchesPerSecond: 100 });
  context = await loadHubSpotContext(client);
});
after(() => hs.close());

const writesSince = (n: number) => hs.requests.slice(n).filter((r) => r.method !== 'GET' && !r.path.endsWith('/search'));

describe('existing contact', () => {
  test('logs the call and task, fills only empty contact fields, uses the Talk user as owner', async () => {
    const n = hs.requests.length;
    const plan = planCall(outbound('new-1', '+12025550123', answered(40)), voicemail, ctx);
    const r = await executePlan(client, hubspotWriter(client), context, plan, options);
    assert.equal(r.result, 'logged');
    assert.equal(r.contactId, '501');
    assert.deepEqual(r.filled, ['firstname', 'lastname', 'company']);
    const writes = writesSince(n);
    assert.deepEqual(writes.map((w) => `${w.method} ${w.path}`), [
      'PATCH /crm/objects/2026-09/contacts/501',
      'POST /crm/objects/2026-09/calls',
      'POST /crm/objects/2026-09/tasks',
    ]);
    assert.deepEqual(writes[0]!.body, { properties: { firstname: 'Bob', lastname: 'Jones', company: 'Jones Plumbing' } });
    const call = writes[1]!.body as { properties: Record<string, string>; associations: Array<{ to: { id: string } }> };
    assert.equal(call.properties.hubspot_owner_id, '101');
    assert.equal(call.associations[0]?.to.id, '501');
    assert.match(call.properties.hs_call_body ?? '', /Filled in on the contact from what they said on this call: first name, last name, company\./);
    assert.ok(!JSON.stringify(writes).includes('{contactId}') && !JSON.stringify(writes).includes('{ownerId}'), 'no placeholders left');
  });

  test('a call already in HubSpot is not logged again', async () => {
    const n = hs.requests.length;
    const r = await executePlan(client, hubspotWriter(client), context, planCall(outbound('vm', '+12025550123', answered(40)), voicemail, ctx), options);
    assert.deepEqual([r.result, r.callId], ['already logged', '9001']);
    assert.equal(writesSince(n).length, 0);
  });

  test('suggest-only mode never touches the contact', async () => {
    const n = hs.requests.length;
    await executePlan(client, hubspotWriter(client), context, planCall(outbound('new-2', '+12025550123', answered(40)), voicemail, ctx), { ...options, autoFill: 'suggest-only' });
    assert.ok(!writesSince(n).some((w) => w.method === 'PATCH'));
  });
});

describe('unknown numbers', () => {
  test('spam guard: a short inbound call with no voicemail creates nothing', async () => {
    const n = hs.requests.length;
    const plan = planCall(rec({ uuid: 'spam', direction: 'in', from: '+12025550188', to: '+12025550111', events: [[0, 'call_started'], [4, 'call_accepted'], [14, 'call_hangup']] }), null, ctx);
    const r = await executePlan(client, hubspotWriter(client), context, plan, options);
    assert.equal(r.result, 'skipped');
    assert.match(r.reason, /spam guard/);
    assert.equal(writesSince(n).length, 0);
  });

  test('an inbound caller who left a voicemail becomes a contact', async () => {
    const n = hs.requests.length;
    const plan = planCall(rec({ uuid: 'vm-in', direction: 'in', from: '+12025550177', to: '+12025550111', events: [[0, 'call_started'], [20, 'call_sent_to_voicemail'], [45, 'vm_msg_recorded'], [46, 'call_hangup']] }), null, ctx);
    const r = await executePlan(client, hubspotWriter(client), context, plan, options);
    assert.equal(r.contactCreated, true);
    const contact = writesSince(n)[0]!;
    assert.equal(contact.path, '/crm/objects/2026-09/contacts');
    assert.deepEqual(contact.body, { properties: { phone: '+12025550177' }, associations: [] });
  });

  test('a number a rep dialled always becomes a contact, with the details they gave', async () => {
    const n = hs.requests.length;
    const r = await executePlan(client, hubspotWriter(client), context, planCall(outbound('out-new', '+12025550166', answered(40)), voicemail, ctx), options);
    assert.equal(r.contactCreated, true);
    assert.deepEqual(writesSince(n)[0]!.body, {
      properties: { phone: '+12025550166', firstname: 'Bob', lastname: 'Jones', company: 'Jones Plumbing', hubspot_owner_id: '101' },
      associations: [],
    });
  });
});

test('a receptionist who took a message is not written onto the contact', () => {
  const plan = planCall(
    outbound('lm', '+12025550123', answered(55)),
    tr([
      ['speaker_1', 'Thanks for calling Riverside Dental, this is Sarah.', 0, 3],
      ['speaker_0', 'Hi Sarah, this is Alex with Northwind Networks. Is Dr. Patel in?', 3.5, 7],
      ['speaker_1', "He's not in right now, can I take a message?", 7.5, 10],
    ]),
    ctx,
  );
  assert.equal(plan.outcome, 'Left live message');
  assert.deepEqual(contactFields(plan), {});
});

test('dry run: reads HubSpot but sends no writes', async () => {
  const n = hs.requests.length;
  const writer = recordingWriter();
  const r = await executePlan(client, writer, context, planCall(outbound('dry', '+12025550155', answered(40)), voicemail, ctx), options);
  assert.equal(r.result, 'logged');
  assert.equal(writesSince(n).length, 0, 'nothing sent to HubSpot');
  assert.deepEqual(writer.writes.map((w) => w.path), ['/crm/objects/2026-09/contacts', '/crm/objects/2026-09/calls', '/crm/objects/2026-09/tasks']);
});

test('if the task fails, the call stays logged and the error is reported', async () => {
  hs.route('POST', '/crm/objects/2026-09/tasks', () => ({ status: 500, body: { message: 'task service down' } }));
  const r = await executePlan(client, hubspotWriter(client), context, planCall(outbound('task-fail', '+12025550123', answered(40)), voicemail, ctx), options);
  assert.equal(r.result, 'logged');
  assert.ok(r.callId);
  assert.equal(r.taskId, null);
  assert.match(r.taskError ?? '', /task service down/);
});

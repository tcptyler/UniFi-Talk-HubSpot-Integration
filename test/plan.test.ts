import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CallRecord, TalkUser, Transcript } from '../src/talk/schemas.ts';
import { loadRules } from '../src/rules/rules.ts';
import { planCall, selfFromTalk, type PlanContext, type CallPlan } from '../src/sync/plan.ts';
import { DEFAULT_OUTCOME_IDS, CONTACT_ID, OWNER_ID } from '../src/hubspot/calls.ts';
import { callRecord } from './helpers/mock-console.ts';

// Made-up data throughout. We are Alex at Northwind Networks.
const users = [
  TalkUser.parse({ unique_id: 'user-alex', first_name: 'Alex', last_name: 'Rivera', email: 'alex@northwind.example', did: '+12025550111' }),
  TalkUser.parse({ unique_id: 'user-sam', full_name: 'Sam Lee', email: 'sam.example.test@gmail.com' }),
];
const self = selfFromTalk(users, [{ did: '+12025550112' }], ['Northwind Networks'], 'US');
const ctx: PlanContext = {
  rules: loadRules(),
  self,
  users: new Map(users.map((u) => [u.unique_id, u])),
  talkUrl: 'https://192.0.2.10/talk/',
  talkSummary: true,
  country: 'US',
  timeZone: 'America/New_York',
  now: Date.parse('2026-11-12T21:00:00Z'),
};

type Ev = [number, string, Record<string, unknown>?];
const answered = (talk: number): Ev[] => [[0, 'call_started'], [6, 'call_accepted'], [6 + talk, 'call_hangup', { hangup_cause: 'normal_end' }]];
const rec = (o: Record<string, unknown> & { events: Ev[] }) => CallRecord.parse(callRecord(o));
const outbound = (events: Ev[], extra: Record<string, unknown> = {}) =>
  rec({ direction: 'out', from: '201', from_did: '+12025550111', from_id: 'user-alex', to: '+12025550123', events, ...extra });
const tr = (lines: Array<[string, string, number, number]>, summary?: string) =>
  Transcript.parse({ status: 'COMPLETED', analytics: { summary, lines: lines.map(([speaker, line, s, e]) => ({ speaker, line, line_start_time: s, line_end_time: e })) } });

const request = (plan: CallPlan, suffix: string) => plan.requests.find((r) => r.path.endsWith(suffix));
const props = (plan: CallPlan, suffix: string) => (request(plan, suffix)?.body as { properties: Record<string, string> }).properties;
const assoc = (plan: CallPlan, suffix: string) => (request(plan, suffix)?.body as { associations: unknown[] }).associations;

describe('who we are', () => {
  test('names, numbers and company email domains come from Talk; free mail domains do not', () => {
    assert.deepEqual(self.names, ['Alex', 'Sam']);
    assert.deepEqual(self.numbers.sort(), ['+12025550111', '+12025550112']);
    assert.deepEqual(self.domains, ['northwind.example']);
  });
});

describe('outbound voicemail', () => {
  const plan = planCall(
    outbound(answered(40), { recording: true }),
    tr(
      [
        ['speaker_0', "Hi, you've reached Bob Jones with Jones Plumbing. Please leave a message after the tone.", 0, 6],
        ['speaker_1', 'Hi Bob, this is Alex from Northwind Networks, following up on your quote. Call me back at 202 555 0111. <script>alert(1)</script>', 8, 20],
      ],
      'Left a voicemail about the quote.',
    ),
    ctx,
  );

  test('looks up the contact, logs the call, creates a review task', () => {
    assert.equal(plan.action, 'log');
    assert.equal(plan.outcome, 'Left voicemail');
    assert.deepEqual(plan.requests.map((r) => `${r.method} ${r.path}`), [
      'POST /crm/objects/2026-09/contacts/search',
      'POST /crm/objects/2026-09/calls',
      'POST /crm/objects/2026-09/tasks',
    ]);
    const search = request(plan, '/contacts/search')?.body as { filterGroups: Array<{ filters: Array<{ value: string }> }> };
    assert.equal(search.filterGroups[0]?.filters[0]?.value, '2025550123');
  });

  test('call properties', () => {
    const p = props(plan, '/calls');
    assert.equal(p.hs_call_direction, 'OUTBOUND');
    assert.equal(p.hs_call_status, 'COMPLETED');
    assert.equal(p.hs_call_disposition, DEFAULT_OUTCOME_IDS['Left voicemail']);
    assert.equal(p.hs_call_duration, '40000');
    assert.equal(p.hs_call_from_number, '+12025550111');
    assert.equal(p.hs_call_to_number, '+12025550123');
    assert.equal(p.hs_call_external_id, plan.uuid);
    assert.equal(p.hubspot_owner_id, OWNER_ID);
    assert.equal(p.hs_call_title, 'Call to (202) 555-0123');
    assert.deepEqual(assoc(plan, '/calls'), [{ to: { id: CONTACT_ID }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 194 }] }]);
  });

  test('notes: outcome, summary, details, link, labelled transcript, all escaped', () => {
    const notes = props(plan, '/calls').hs_call_body ?? '';
    assert.match(notes, /<b>Outcome:<\/b> Left voicemail/);
    assert.match(notes, /<b>Talk summary:<\/b> Left a voicemail about the quote\./);
    assert.match(notes, /Name: Bob Jones, Company: Jones Plumbing/);
    assert.match(notes, /<a href="https:\/\/192\.0\.2\.10\/talk\/">Open UniFi Talk<\/a> to play the recording/);
    assert.match(notes, /Them: Hi, you've reached Bob Jones/);
    assert.match(notes, /Alex: Hi Bob, this is Alex/);
    assert.ok(!notes.includes('<script>'), 'transcript text is escaped');
    assert.ok(notes.includes('&lt;script&gt;'));
  });

  test('review task', () => {
    const t = props(plan, '/tasks');
    assert.equal(t.hs_task_subject, 'Confirm call outcome: Left voicemail ((202) 555-0123)');
    assert.equal(t.hs_task_type, 'CALL');
    assert.equal(t.hs_timestamp, '2026-11-12T21:30:00.000Z', 'due 30 minutes after it is created');
    assert.equal(t.hubspot_owner_id, OWNER_ID);
  });

  test('switching off the Talk summary removes it', () => {
    const off = planCall(outbound(answered(40)), tr([['speaker_0', 'Hello?', 0, 1]], 'A summary.'), { ...ctx, talkSummary: false });
    assert.doesNotMatch(props(off, '/calls').hs_call_body ?? '', /Talk summary/);
  });
});

describe('other calls', () => {
  test('busy', () => {
    const plan = planCall(outbound([[0, 'call_started'], [2, 'call_hangup', { hangup_cause: 'refused' }]]), null, ctx);
    assert.equal(props(plan, '/calls').hs_call_status, 'BUSY');
    assert.equal(props(plan, '/calls').hs_call_disposition, DEFAULT_OUTCOME_IDS.Busy);
  });

  test('missed inbound with a voicemail gets a call-back task', () => {
    const plan = planCall(
      rec({ direction: 'in', from: '+12025550123', to: '+12025550112', events: [[0, 'call_started'], [20, 'call_sent_to_voicemail'], [45, 'vm_msg_recorded'], [46, 'call_hangup']] }),
      null,
      ctx,
    );
    assert.equal(props(plan, '/calls').hs_call_status, 'NO_ANSWER');
    assert.equal(props(plan, '/calls').hs_call_has_voicemail, 'true');
    assert.equal(props(plan, '/tasks').hs_task_subject, 'Return call: (202) 555-0123 left a voicemail');
  });

  test('missed inbound from a withheld number: logged without a contact and without a task', () => {
    const plan = planCall(rec({ direction: 'in', from: 'anonymous', to: '+12025550112', events: [[0, 'call_started'], [30, 'call_hangup', { hangup_cause: 'cancelled' }]] }), null, ctx);
    assert.deepEqual(plan.requests.map((r) => r.purpose), ['log the call']);
    assert.deepEqual(assoc(plan, '/calls'), []);
    assert.match(plan.notes.join(' '), /without a contact/);
  });

  test('internal calls are skipped and unfinished calls wait', () => {
    const internal = planCall(rec({ direction: null, from: '201', to: '202', events: answered(30) }), null, ctx);
    assert.deepEqual([internal.action, internal.requests.length], ['skip', 0]);
    const ringing = planCall(outbound([[0, 'call_started']], { time: new Date(ctx.now! - 60_000).toISOString() }), null, ctx);
    assert.equal(ringing.action, 'wait');
  });

  test('a call Talk never closed is logged after two hours', () => {
    const stale = planCall(outbound([[0, 'call_started'], [5, 'call_accepted']], { time: new Date(ctx.now! - 3 * 3_600_000).toISOString() }), null, ctx);
    assert.equal(stale.action, 'log');
    assert.match(stale.notes.join(' '), /never reported the end/);
  });

  test('meeting booked uses the custom outcome when there is one, else Connected', () => {
    const meeting = tr([
      ['speaker_0', 'Hi, this is Jane Doe with Acme Roofing.', 0, 3],
      ['speaker_1', 'Hi Jane, this is Alex from Northwind Networks. Could we set up a demo next Tuesday at 3 pm?', 3.5, 9],
      ['speaker_0', 'That works for me.', 9.5, 11],
    ]);
    const plain = planCall(outbound(answered(120)), meeting, ctx);
    assert.equal(plain.outcome, 'Meeting booked');
    assert.equal(props(plain, '/calls').hs_call_disposition, DEFAULT_OUTCOME_IDS.Connected);
    assert.match(plain.notes.join(' '), /No custom "Meeting booked" outcome/);
    assert.match(props(plain, '/calls').hs_call_body ?? '', /Meeting agreed:<\/b> Tue, Nov 17, 3:00 PM EST.*Add to Google Calendar/);
    const custom = planCall(outbound(answered(120)), meeting, { ...ctx, meetingBookedOutcomeId: '11111111-2222-3333-4444-555555555555' });
    assert.equal(props(custom, '/calls').hs_call_disposition, '11111111-2222-3333-4444-555555555555');
  });
});

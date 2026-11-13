import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CallRecord } from '../src/talk/schemas.ts';
import { callFacts, isReadyToLog } from '../src/talk/facts.ts';
import { callRecord, at } from './helpers/mock-console.ts';

const facts = (overrides: Parameters<typeof callRecord>[0]) => callFacts(CallRecord.parse(callRecord(overrides)));

test('answered inbound call', () => {
  const f = facts({
    direction: 'in',
    from: '+12025550100',
    to: '+12025550199',
    answered_by_user_uuid: 'user-a',
    from_caller_name: 'SMITH J',
    recording: true,
    events: [[0, 'call_received'], [8, 'call_accepted'], [128, 'call_hangup', { hangup_cause: 'normal_end' }]],
  });
  assert.equal(f.direction, 'inbound');
  assert.equal(f.status, 'answered');
  assert.equal(f.talkSeconds, 120);
  assert.equal(f.externalNumber, '+12025550100');
  assert.equal(f.ourNumber, '+12025550199');
  assert.equal(f.userUuid, 'user-a');
  assert.equal(f.callerName, 'SMITH J');
  assert.equal(f.hasRecording, true);
});

test('outbound call refused by the far end is busy', () => {
  const f = facts({
    direction: 'out',
    from: '201',
    from_did: '+12025550199',
    to: '+12025550123',
    from_id: 'user-b',
    events: [[0, 'call_placed'], [3, 'call_hangup', { hangup_cause: 'refused' }]],
  });
  assert.equal(f.direction, 'outbound');
  assert.equal(f.status, 'busy');
  assert.equal(f.externalNumber, '+12025550123');
  assert.equal(f.ourNumber, '+12025550199');
  assert.equal(f.userUuid, 'user-b');
  assert.equal(f.callerName, null, 'caller ID name only applies to inbound');
});

test('unanswered inbound call that left a voicemail', () => {
  const f = facts({
    direction: 'in',
    events: [[0, 'call_received'], [20, 'call_sent_to_voicemail'], [45, 'vm_msg_recorded'], [46, 'call_hangup', { hangup_cause: 'normal_end' }]],
  });
  assert.equal(f.status, 'no_answer');
  assert.equal(f.wentToVoicemail, true);
  assert.equal(f.voicemailLeft, true);
  assert.equal(f.talkSeconds, 0);
});

test('accepted_by_user_uuid on the event is used when the record has no answerer', () => {
  const f = facts({ direction: 'in', events: [[0, 'call_received'], [2, 'call_accepted', { accepted_by_user_uuid: 'user-c' }], [9, 'call_hangup']] });
  assert.equal(f.userUuid, 'user-c');
});

test('internal calls have no external number', () => {
  const f = facts({ direction: null, from: '201', to: '202', events: [[0, 'call_placed'], [1, 'call_accepted'], [5, 'call_hangup']] });
  assert.equal(f.direction, 'internal');
  assert.equal(f.externalNumber, null);
});

test('events out of order are sorted; the last hang-up wins', () => {
  const f = facts({
    direction: 'in',
    events: [[30, 'call_hangup', { hangup_cause: 'normal_end' }], [0, 'call_received'], [10, 'call_accepted'], [12, 'call_hangup', { hangup_cause: 'cancelled' }]],
  });
  assert.equal(f.hangupCause, 'normal_end');
  assert.equal(f.talkSeconds, 20);
});

test('a call without a hang-up is in progress until it goes stale', () => {
  const f = facts({ direction: 'in', time: at(0), events: [[0, 'call_received']] });
  assert.equal(f.status, 'in_progress');
  const start = Date.parse(at(0));
  assert.equal(isReadyToLog(f, start + 60_000), false);
  assert.equal(isReadyToLog(f, start + 3 * 60 * 60_000), true);
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CallRecord, Transcript } from '../src/talk/schemas.ts';
import { callFacts } from '../src/talk/facts.ts';
import { loadRules, compileRules, RulesError } from '../src/rules/rules.ts';
import { classifyCall, assignSides, transcriptLines, type ClassifyContext } from '../src/rules/classify.ts';
import { normalizeTranscript } from '../src/rules/normalize.ts';
import { extractIdentities, extractPhones, extractEmails, extractMeetings, calendarLinks } from '../src/rules/extract.ts';
import { zonedTime, zoneOffsetMinutes } from '../src/time.ts';
import { callRecord } from './helpers/mock-console.ts';

// Everything here is made up. "We" are Alex at Northwind Networks.
const rules = loadRules();
const ctx: ClassifyContext = {
  rules,
  self: { names: ['Alex'], companies: ['Northwind Networks'], numbers: ['+12025550111'], domains: ['northwind.example'] },
  defaultCountry: 'US',
};

type Ev = [number, string, Record<string, unknown>?];
const answered = (talk: number): Ev[] => [[0, 'call_started'], [6, 'call_accepted'], [6 + talk, 'call_hangup', { hangup_cause: 'normal_end' }]];
const call = (direction: 'in' | 'out' | null, events: Ev[], extra: Record<string, unknown> = {}) => callFacts(CallRecord.parse(callRecord({ direction, events, ...extra })));
const tr = (lines: Array<[string, string, number?, number?]>) =>
  Transcript.parse({ status: 'COMPLETED', analytics: { lines: lines.map(([speaker, line, start, end]) => ({ speaker, line, line_start_time: start, line_end_time: end })) } });
const classify = (facts: ReturnType<typeof call>, transcript: ReturnType<typeof tr> | null) => classifyCall(facts, transcript, ctx);

const VOICEMAIL_THEM = "Hi, you've reached Bob Jones with Jones Plumbing. I'm not available, please leave a message after the tone.";
const VOICEMAIL_US = 'Hi Bob, this is Alex from Northwind Networks, following up on the quote. Call me back at two zero two, five five five, zero one one one. Thanks.';

describe('outcomes', () => {
  test('outbound voicemail, message left', () => {
    const r = classify(call('out', answered(40)), tr([['speaker_0', VOICEMAIL_THEM, 0, 7], ['speaker_1', VOICEMAIL_US, 9, 21]]));
    assert.equal(r.outcome, 'Left voicemail', r.rule);
    assert.equal(r.sides?.their, 'speaker_0');
    assert.deepEqual(r.details.identities.map((i) => [i.name?.first, i.name?.last, i.company]), [['Bob', 'Jones', 'Jones Plumbing']]);
    assert.deepEqual(r.details.phones, [], 'our own callback number is never suggested');
  });

  test('same call with the speaker labels swapped', () => {
    const r = classify(call('out', answered(40)), tr([['speaker_1', VOICEMAIL_THEM, 0, 7], ['speaker_0', VOICEMAIL_US, 9, 21]]));
    assert.equal(r.outcome, 'Left voicemail');
    assert.equal(r.sides?.our, 'speaker_0');
  });

  test('hung up at the beep', () => {
    const r = classify(call('out', answered(9)), tr([['speaker_0', 'You have reached the voicemail of Linda Park. Please leave your message after the tone.', 0, 6], ['speaker_1', 'Oh.', 7, 7.5]]));
    assert.equal(r.outcome, 'No answer');
    assert.match(r.rule, /only 1 words/);
  });

  test('voicemail transcribed as a single speaker', () => {
    const r = classify(call('out', answered(40)), tr([['speaker_0', VOICEMAIL_THEM, 0, 7], ['speaker_0', VOICEMAIL_US, 9, 21]]));
    assert.equal(r.sides?.method, 'single-speaker');
    assert.equal(r.outcome, 'Left voicemail');
  });

  test('receptionist takes a message', () => {
    const r = classify(call('out', answered(55)), tr([
      ['speaker_1', 'Thanks for calling Riverside Dental, this is Sarah.', 0, 3],
      ['speaker_0', 'Hi Sarah, this is Alex with Northwind Networks. Is Dr. Patel in?', 3.5, 7],
      ['speaker_1', "He's not in right now, can I take a message?", 7.5, 10],
      ['speaker_0', 'Sure, have him call me at 202 555 0111.', 10.5, 14],
    ]));
    assert.equal(r.outcome, 'Left live message');
    assert.deepEqual(r.details.identities.map((i) => [i.name?.first, i.company]), [['Sarah', 'Riverside Dental']]);
  });

  test('receptionist offering voicemail mid-conversation is still a live message', () => {
    const r = classify(call('out', answered(70)), tr([
      ['speaker_1', 'Good morning, Acme Roofing.', 0, 2],
      ['speaker_0', 'Hi, this is Alex with Northwind Networks, is Bob available?', 2.5, 6],
      ['speaker_1', "She's not available, would you like to leave a message?", 6.5, 9],
      ['speaker_0', 'Yes please, tell her Alex called about the network quote and to call me back today.', 9.5, 15],
    ]));
    assert.equal(r.outcome, 'Left live message', r.rule);
  });

  test('inbound: meeting booked, caller shares email and cell', () => {
    const r = classify(call('in', answered(300)), tr([
      ['speaker_0', 'Thanks for calling Northwind Networks, this is Alex.', 0, 3],
      ['speaker_1', 'Hi, this is Jane Doe with Acme Roofing, calling for Alex about a network quote.', 3.5, 8],
      ['speaker_0', "Happy to help. I'd love to set up a demo. How about next Tuesday at 3 pm?", 8.5, 13],
      ['speaker_1', 'That works. My email is jane dot doe at acme roofing dot com and my cell is 202-555-0147.', 13.5, 20],
    ]));
    assert.equal(r.outcome, 'Meeting booked');
    assert.equal(r.sides?.our, 'speaker_0');
    assert.deepEqual(r.details.emails, ['jane.doe@acmeroofing.com']);
    assert.deepEqual(r.details.phones, [{ e164: '+12025550147', label: 'mobile' }]);
    assert.deepEqual(r.details.identities.map((i) => [i.name?.first, i.name?.last, i.company]), [['Jane', 'Doe', 'Acme Roofing']]);
    const meeting = r.details.meetings[0]!;
    assert.equal(meeting.agreed, true);
    assert.equal(meeting.start.getDate(), 17, 'next Tuesday after Thursday 12 Nov 2026');
  });

  test('inbound with no cues: the first speaker is us', () => {
    const r = classify(call('in', answered(95)), tr([['speaker_1', 'Hello?', 0, 1], ['speaker_0', 'Hi, I have a quick question about my order from last week.', 1.5, 5]]));
    assert.equal(r.outcome, 'Connected');
    assert.deepEqual([r.sides?.our, r.sides?.method], ['speaker_1', 'direction']);
  });

  test('wrong number', () => {
    const r = classify(call('out', answered(9)), tr([['speaker_0', 'Hello?', 0, 1], ['speaker_1', 'Hi, is this Mike?', 1.5, 3], ['speaker_0', 'No, sorry, you have the wrong number.', 3.5, 6]]));
    assert.equal(r.outcome, 'Wrong number');
    assert.equal(r.evidence, 'wrong number');
  });

  test('carrier intercept', () => {
    const r = classify(call('out', answered(12)), tr([['speaker_0', "We're sorry, the number you have dialed is not in service. Please check the number and dial again.", 0, 8]]));
    assert.equal(r.outcome, 'Wrong number');
  });

  test('mailbox full', () => {
    const r = classify(call('out', answered(8)), tr([['speaker_0', 'The mailbox is full and cannot accept any messages at this time. Goodbye.', 0, 6]]));
    assert.equal(r.outcome, 'No answer');
    assert.match(r.rule, /full or not set up/);
  });

  test('events only: busy, rang out, caller voicemail, internal, unfinished', () => {
    assert.equal(classify(call('out', [[0, 'call_started'], [2, 'call_hangup', { hangup_cause: 'refused' }]]), null).outcome, 'Busy');
    assert.equal(classify(call('out', [[0, 'call_started'], [30, 'call_hangup', { hangup_cause: 'cancelled' }]]), null).outcome, 'No answer');
    const vm = classify(call('in', [[0, 'call_started'], [20, 'call_sent_to_voicemail'], [45, 'vm_msg_recorded'], [46, 'call_hangup']]), null);
    assert.deepEqual([vm.outcome, vm.rule], ['No answer', 'not answered; the caller left a voicemail']);
    assert.equal(classify(call(null, answered(30)), null).outcome, null);
    assert.equal(classify(call('in', [[0, 'call_started']]), null).outcome, null);
  });

  test('answered without a transcript', () => {
    assert.equal(classify(call('in', answered(5)), null).outcome, 'Connected', 'inbound answered by a rep is connected');
    assert.equal(classify(call('out', answered(5)), null).outcome, 'No answer', 'short outbound is probably a voicemail system');
    assert.equal(classify(call('out', answered(95)), null).outcome, 'Connected');
  });
});

describe('details', () => {
  test('all-lowercase transcripts give no names rather than guesses', () => {
    assert.deepEqual(extractIdentities('hi this is jane doe with acme roofing', rules, ctx.self), []);
  });

  test('our own introductions are not suggested', () => {
    assert.deepEqual(extractIdentities('Hi, this is Alex from Northwind Networks.', rules, ctx.self), []);
  });

  test('titles and company-only greetings', () => {
    const ids = extractIdentities('You have reached the office of Dr. Patel. Thank you for calling Acme.', rules, ctx.self);
    assert.deepEqual(ids.map((i) => [i.name?.last ?? null, i.company]), [['Patel', null], [null, 'Acme']]);
  });

  test('phone labels and exclusions', () => {
    const phones = extractPhones('office 202-555-0123, cell 202 555 0147, fax 2025550199, ours 202-555-0111', { exclude: ctx.self.numbers });
    assert.deepEqual(phones, [
      { e164: '+12025550123', label: 'work' },
      { e164: '+12025550147', label: 'mobile' },
      { e164: '+12025550199', label: 'fax' },
    ]);
  });

  test('emails skip our own domain', () => {
    assert.deepEqual(extractEmails('me@northwind.example or Pat@Acme.example.', { excludeDomains: ['northwind.example'] }), ['pat@acme.example']);
  });

  test('meeting times are read in the business time zone, across daylight saving changes', () => {
    const say = 'Can we book a demo next Monday at 9 am? Sounds good.';
    // Thursday 29 Oct 2026, 2 pm in New York (daylight time); the clocks go back on 1 Nov.
    const [m] = extractMeetings(say, new Date('2026-10-29T18:00:00Z'), rules, 'America/New_York');
    assert.equal(m?.start.toISOString(), '2026-11-02T14:00:00.000Z', '9 am standard time');
    // 11 pm Thursday in New York is already Friday in UTC: "tomorrow" is still Friday.
    const [t] = extractMeetings("Let's meet tomorrow at 10 am. Perfect.", new Date('2026-11-13T04:00:00Z'), rules, 'America/New_York');
    assert.equal(t?.start.toISOString(), '2026-11-13T15:00:00.000Z');
  });

  test('zone helpers', () => {
    assert.equal(zoneOffsetMinutes(new Date('2026-07-01T12:00:00Z'), 'America/New_York'), -240);
    assert.equal(zoneOffsetMinutes(new Date('2026-12-01T12:00:00Z'), 'America/New_York'), -300);
    assert.equal(zonedTime(2026, 3, 8, 12, 0, 'America/New_York').toISOString(), '2026-03-08T16:00:00.000Z');
    assert.equal(zonedTime(2026, 11, 17, 15, 0, 'Europe/London').toISOString(), '2026-11-17T15:00:00.000Z');
  });

  test('calendar links need no API', () => {
    const links = calendarLinks({ title: 'Demo', start: new Date('2026-11-17T20:00:00Z'), attendee: 'pat@acme.example' });
    assert.match(links.google, /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE&text=Demo&dates=20261117T200000Z%2F20261117T203000Z/);
    assert.match(links.outlook, /^https:\/\/outlook\.office\.com\/calendar\/0\/deeplink\/compose\?subject=Demo/);
  });
});

describe('normalising speech', () => {
  for (const [said, written] of [
    ['call me at five five five eight six seven five three oh nine', 'call me at 5558675309'],
    ['my number is double five five, two oh one, three three four four', 'my number is 5552013344'],
    ['I have one of those and two of the others', 'I have one of those and two of the others'],
    ['email john underscore smith at example dot com please', 'email john_smith@example.com please'],
    ['meet at the office at 3', 'meet at the office at 3'],
  ] as const) {
    test(said, () => assert.equal(normalizeTranscript(said), written));
  }
});

describe('rules file', () => {
  test('a bad pattern is reported with its location', () => {
    const bad = { version: 1, thresholds: {}, outcomes: { wrongNumber: ['ok', '(unclosed'] }, meetings: {}, identity: {} };
    assert.throws(() => compileRules(bad), (e: unknown) => e instanceof RulesError && /outcomes\.wrongNumber\[1\]/.test(e.message));
  });

  test('a custom rules file replaces the defaults', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uth-rules-')), 'rules.yaml');
    fs.writeFileSync(file, "version: 1\nthresholds: { voicemailMinWords: 3 }\noutcomes:\n  wrongNumber: ['nobody by that name, mate']\nmeetings: {}\nidentity: {}\n");
    const custom = loadRules(file);
    assert.equal(custom.thresholds.voicemailMinWords, 3);
    assert.equal(custom.outcomes.wrongNumber.length, 1);
    assert.equal(custom.outcomes.voicemailGreeting.length, 0);
  });

  test('transcript times may be strings (Talk 5.3) or numbers (5.4)', () => {
    const lines = transcriptLines(Transcript.parse({ status: 'COMPLETED', analytics: { lines: [{ speaker: 'a', line: 'x', line_start_time: '0.59', line_end_time: 8.45 }] } }));
    assert.deepEqual([lines[0]?.start, lines[0]?.end], [0.59, 8.45]);
  });

  test('sides with three speakers still pick one of ours', () => {
    const lines = transcriptLines(tr([['a', 'Press one for sales.', 0, 2], ['b', 'Thanks for calling Northwind Networks, this is Alex.', 3, 5], ['c', 'Hi Alex.', 6, 7]]));
    assert.equal(assignSides(lines, 'inbound', ctx).our, 'b');
  });
});

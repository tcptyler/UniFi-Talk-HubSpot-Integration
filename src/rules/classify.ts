// Picks the HubSpot call outcome for a Talk call from its events and, when there is one, its transcript.
// Transcript speaker labels (speaker_0, speaker_1) don't say which side is ours, so that is worked out first.
// Every result says which rule decided it, so a rep can see why.
import type { CountryCode } from 'libphonenumber-js';
import type { CallFacts } from '../talk/facts.ts';
import type { Transcript } from '../talk/schemas.ts';
import { normalizeTranscript } from './normalize.ts';
import { extractEmails, extractIdentities, extractMeetings, extractPhones, type FoundPhone, type Identity, type Meeting, type Self } from './extract.ts';
import { firstMatch, type Rules } from './rules.ts';

export const OUTCOMES = ['Connected', 'Busy', 'No answer', 'Left voicemail', 'Left live message', 'Meeting booked', 'Wrong number'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface Line {
  speaker: string;
  text: string;
  start: number | null;
  end: number | null;
}

export interface Sides {
  our: string | null;
  their: string | null;
  method: 'no-lines' | 'single-speaker' | 'content' | 'direction';
  evidence: string[];
}

export interface Details {
  identities: Identity[];
  phones: FoundPhone[];
  emails: string[];
  meetings: Meeting[];
}

export interface Classification {
  /** null: the call is not logged (internal) or not finished yet. */
  outcome: Outcome | null;
  rule: string;
  /** The words that triggered the rule, when a phrase rule decided. */
  evidence: string | null;
  sides: Sides | null;
  lines: Line[];
  details: Details;
}

export interface ClassifyContext {
  rules: Rules;
  self: Self;
  /** Names of the Talk user on this call; the strongest sign of which speaker is ours. */
  userNames?: string[];
  defaultCountry?: CountryCode;
  /** Where the business is, for reading dates and times said on the call. */
  timeZone?: string;
}

const NO_DETAILS: Details = { identities: [], phones: [], emails: [], meetings: [] };
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const seconds = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export function transcriptLines(transcript: Transcript | null): Line[] {
  return (transcript?.analytics?.lines ?? []).map((l) => ({
    speaker: l.speaker,
    text: normalizeTranscript(l.line),
    start: seconds(l.line_start_time),
    end: seconds(l.line_end_time),
  }));
}

/** Which label is us: by what each side says, else by who spoke first. */
export function assignSides(lines: Line[], direction: 'inbound' | 'outbound', ctx: ClassifyContext): Sides {
  const labels = [...new Set(lines.map((l) => l.speaker))];
  if (labels.length === 0) return { our: null, their: null, method: 'no-lines', evidence: [] };
  if (labels.length === 1) return { our: null, their: labels[0] ?? null, method: 'single-speaker', evidence: [] };
  const names = ctx.userNames?.length ? ctx.userNames : ctx.self.names;
  // Only introductions count ("this is <our user>", "with <our company>"). Someone asking for one of our
  // people ("calling for Sam") must not make their side look like ours.
  const ourIntro = [
    ...names.map((n) => new RegExp(`\\b(?:this is|my name is|i'm|i am|it's)\\s+${escape(n)}\\b`, 'i')),
    ...ctx.self.companies.map((c) => new RegExp(`\\b(?:from|with|at|calling from)\\s+(?:the\\s+)?${escape(c)}\\b`, 'i')),
    ...ctx.self.companies.map((c) => new RegExp(`thank(?:s| you) for calling (?:the\\s+)?${escape(c)}`, 'i')),
  ];
  const o = ctx.rules.outcomes;
  const theirCues = [...o.voicemailGreeting, ...o.wrongNumber, ...o.liveMessage, ...o.mailboxUnavailable];
  const score = new Map(labels.map((l) => [l, 0]));
  const evidence = new Set<string>();
  for (const line of lines) {
    if (ourIntro.some((re) => re.test(line.text))) {
      score.set(line.speaker, (score.get(line.speaker) ?? 0) + 2);
      evidence.add(`${line.speaker}: introduced as us`);
    }
    if (theirCues.some((re) => re.test(line.text))) {
      score.set(line.speaker, (score.get(line.speaker) ?? 0) - 2);
      evidence.add(`${line.speaker}: voicemail, receptionist or wrong-number words`);
    }
  }
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  if (top && second && top[1] !== second[1]) {
    const their = labels.length === 2 ? (labels.find((l) => l !== top[0]) ?? null) : (ranked.at(-1)?.[0] ?? null);
    return { our: top[0], their, method: 'content', evidence: [...evidence] };
  }
  // No cues: on inbound calls we answer and speak first; on outbound calls they answer and speak first.
  const firstSpeaker = lines[0]?.speaker ?? null;
  const other = labels.find((l) => l !== firstSpeaker) ?? null;
  return direction === 'inbound'
    ? { our: firstSpeaker, their: other, method: 'direction', evidence: [] }
    : { our: other, their: firstSpeaker, method: 'direction', evidence: [] };
}

export function classifyCall(facts: CallFacts, transcript: Transcript | null, ctx: ClassifyContext, refDate = facts.startedAt): Classification {
  const result = (outcome: Outcome | null, rule: string, extra: Partial<Classification> = {}): Classification => ({
    outcome,
    rule,
    evidence: null,
    sides: null,
    lines: [],
    details: NO_DETAILS,
    ...extra,
  });
  const { thresholds, outcomes: o } = ctx.rules;

  if (facts.direction === 'internal') return result(null, 'internal call (not logged)');
  if (facts.status === 'in_progress') return result(null, 'call not finished yet');
  if (facts.direction === 'outbound' && facts.status === 'busy') return result('Busy', 'the other end refused the call (busy)');
  if (facts.status !== 'answered') {
    return result('No answer', facts.voicemailLeft ? 'not answered; the caller left a voicemail' : 'not answered');
  }

  const lines = transcriptLines(transcript);
  if (!lines.length) {
    if (facts.direction === 'inbound') return result('Connected', 'answered (no transcript)');
    return facts.talkSeconds >= thresholds.connectedMinSeconds
      ? result('Connected', 'answered (no transcript)')
      : result('No answer', `answered but under ${thresholds.connectedMinSeconds} s with no transcript (likely voicemail)`);
  }

  const sides = assignSides(lines, facts.direction, ctx);
  const textOf = (label: string | null) => lines.filter((l) => l.speaker === label).map((l) => l.text).join(' ');
  const all = lines.map((l) => l.text).join(' ');
  const their = sides.their && sides.our ? textOf(sides.their) : all;
  // Details only come from the other party's words, so our own callback number never lands on the contact.
  const details: Details = {
    identities: extractIdentities(their, ctx.rules, ctx.self),
    phones: extractPhones(their, { defaultCountry: ctx.defaultCountry, exclude: ctx.self.numbers }),
    emails: extractEmails(their, { excludeDomains: ctx.self.domains }),
    meetings: extractMeetings(all, refDate, ctx.rules, ctx.timeZone),
  };
  const base = { sides, lines, details };

  // Recorded network messages can get either speaker label, so check everything said.
  let hit = firstMatch(o.carrierIntercept, all);
  if (hit) return result('Wrong number', 'recorded "number not in service" message', { ...base, evidence: hit.text });
  hit = firstMatch(o.wrongNumber, their);
  if (hit) return result('Wrong number', 'the other party said it was the wrong number', { ...base, evidence: hit.text });

  if (facts.direction === 'outbound') {
    hit = firstMatch(o.mailboxUnavailable, all);
    if (hit) return result('No answer', 'their voicemail is full or not set up', { ...base, evidence: hit.text });
    const voicemail = voicemailCheck(lines, sides, ctx.rules);
    if (voicemail) {
      return voicemail.ourWordsAfter >= thresholds.voicemailMinWords
        ? result('Left voicemail', `voicemail greeting, then ${voicemail.ourWordsAfter} words from us`, { ...base, evidence: voicemail.greeting })
        : result('No answer', `voicemail greeting, then only ${voicemail.ourWordsAfter} words from us`, { ...base, evidence: voicemail.greeting });
    }
  }

  hit = firstMatch(o.liveMessage, their);
  if (hit) return result('Left live message', 'someone on their side took a message', { ...base, evidence: hit.text });

  const booked = details.meetings.find((m) => m.agreed);
  if (booked) return result('Meeting booked', 'meeting words, a date or time, and agreement', { ...base, evidence: booked.phrase });

  const short = facts.direction === 'outbound' && facts.talkSeconds < thresholds.connectedMinSeconds;
  return result('Connected', short ? 'answered (short call)' : 'answered', base);
}

/**
 * A voicemail is their greeting before we said much, followed by our message. If we were already talking
 * before the greeting (a receptionist saying "would you like to leave a message?"), it is not a voicemail.
 */
function voicemailCheck(lines: Line[], sides: Sides, rules: Rules): { greeting: string; ourWordsAfter: number } | null {
  const greetingSide = sides.our ? sides.their : null; // single speaker: any line may be the greeting
  const isGreeting = (l: Line) => (greetingSide === null || l.speaker === greetingSide) && firstMatch(rules.outcomes.voicemailGreeting, l.text);
  const greetingIdx = lines.map((l, i) => (isGreeting(l) ? i : -1)).filter((i) => i >= 0);
  const firstIdx = greetingIdx[0];
  const lastIdx = greetingIdx.at(-1);
  if (firstIdx === undefined || lastIdx === undefined) return null;
  const firstGreeting = lines[firstIdx]!;
  const lastGreeting = lines[lastIdx]!;
  const greetingStart = firstGreeting.start;
  const greetingEnd = Math.max(...greetingIdx.map((i) => lines[i]!.end ?? -Infinity));
  const timed = greetingStart !== null && Number.isFinite(greetingEnd);
  const ours = (l: Line, i: number) => (sides.our ? l.speaker === sides.our : !greetingIdx.includes(i));
  const before = lines.filter((l, i) => ours(l, i) && (timed && l.start !== null ? l.start < greetingStart! : i < firstIdx));
  if (before.reduce((n, l) => n + wordCount(l.text), 0) > rules.thresholds.voicemailMaxWordsBeforeGreeting) return null;
  const after = lines.filter((l, i) => ours(l, i) && (timed && l.start !== null ? l.start >= greetingEnd : i > lastIdx));
  return { greeting: firstMatch(rules.outcomes.voicemailGreeting, lastGreeting.text)?.text ?? '', ourWordsAfter: after.reduce((n, l) => n + wordCount(l.text), 0) };
}

// Builds the HubSpot requests for one Talk call: find the contact, log the call, and ask the rep to confirm.
// Pure functions: nothing here talks to HubSpot, so dry runs and real runs build exactly the same requests.
import { formatPhone, nationalNumber, type CountryCode } from '../phone.ts';
import type { CallFacts } from '../talk/facts.ts';
import type { Classification, Outcome } from '../rules/classify.ts';
import { calendarLinks } from '../rules/extract.ts';

export const API_VERSION = '2026-09';

/** HubSpot's built-in call outcomes. Their ids are the same in every portal. */
export const DEFAULT_OUTCOME_IDS: Record<Exclude<Outcome, 'Meeting booked'>, string> = {
  Busy: '9d9162e7-6cf3-4944-bf63-4dff82258764',
  Connected: 'f240bbac-87c9-4f6e-bf70-924b57d47db7',
  'Left live message': 'a4c4c377-d246-4b32-a13b-75a56a4cd0ff',
  'Left voicemail': 'b2cf5968-551e-4856-9783-52b3da59a7d0',
  'No answer': '73a0d17f-1163-4015-bdd5-ec830791da20',
  'Wrong number': '17b47fee-58de-441e-a44c-c6300d46f273',
};

/** HubSpot-defined association types. */
export const ASSOCIATION = { callToContact: 194, callToCompany: 182, taskToContact: 204, taskToCompany: 192 } as const;

/** Placeholders filled in at run time, after the contact and owner lookups. */
export const CONTACT_ID = '{contactId}';
export const OWNER_ID = '{ownerId}';

/** Text properties hold at most 65,536 characters. */
const MAX_BODY = 65_000;

export interface PlannedRequest {
  purpose: string;
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: unknown;
}

export function outcomeId(outcome: Outcome, meetingBookedId?: string): string {
  return outcome === 'Meeting booked' ? (meetingBookedId ?? DEFAULT_OUTCOME_IDS.Connected) : DEFAULT_OUTCOME_IDS[outcome];
}

export function callStatus(facts: CallFacts): 'COMPLETED' | 'BUSY' | 'NO_ANSWER' {
  if (facts.status === 'busy') return 'BUSY';
  return facts.answered ? 'COMPLETED' : 'NO_ANSWER';
}

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function formatWhen(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short' }).format(date);
}

/** Contact search by phone. HubSpot matches the national number in its calculated phone fields. */
export function contactSearch(e164: string): PlannedRequest {
  const national = nationalNumber(e164);
  const filter = (propertyName: string) => ({ filters: [{ propertyName, operator: 'EQ', value: national }] });
  return {
    purpose: 'find the contact by phone number',
    method: 'POST',
    path: `/crm/objects/${API_VERSION}/contacts/search`,
    body: {
      filterGroups: [filter('hs_searchable_calculated_phone_number'), filter('hs_searchable_calculated_mobile_number')],
      properties: ['firstname', 'lastname', 'email', 'phone', 'mobilephone', 'company', 'hubspot_owner_id'],
      limit: 10,
    },
  };
}

export interface NotesInput {
  facts: CallFacts;
  cls: Classification;
  /** Link to Talk's web page, where the recording can be played. */
  talkUrl: string;
  /** Talk's own summary, or null when there is none or it is switched off. */
  summary: string | null;
  ourLabel: string;
  timeZone?: string;
  country?: CountryCode;
}

/** The call notes (HTML): outcome and why, Talk's summary, details mentioned, meeting links, transcript. */
export function callNotes(input: NotesInput): string {
  const { facts, cls, talkUrl, summary, ourLabel, timeZone, country } = input;
  const parts: string[] = [];
  parts.push('<p><b>Logged automatically from UniFi Talk.</b> Please check the outcome and details.</p>');
  if (cls.outcome) {
    const why = cls.evidence ? `${cls.rule}: "${cls.evidence}"` : cls.rule;
    parts.push(`<p><b>Outcome:</b> ${escapeHtml(cls.outcome)} <i>(${escapeHtml(why)})</i></p>`);
  }
  if (summary) parts.push(`<p><b>Talk summary:</b> ${escapeHtml(summary)}</p>`);

  const d = cls.details;
  const mentioned: string[] = [];
  for (const id of d.identities) {
    const name = id.name ? [id.name.first, id.name.last].filter(Boolean).join(' ') : '';
    mentioned.push([name && `Name: ${name}`, id.company && `Company: ${id.company}`].filter(Boolean).join(', '));
  }
  for (const p of d.phones) mentioned.push(`Phone (${p.label}): ${formatPhone(p.e164, country)}`);
  for (const e of d.emails) mentioned.push(`Email: ${e}`);
  if (mentioned.length) parts.push(`<p><b>Details they mentioned</b><br>${mentioned.map(escapeHtml).join('<br>')}</p>`);

  for (const m of d.meetings) {
    const links = calendarLinks({ title: 'Meeting', start: m.start, attendee: d.emails[0] ?? '' });
    const when = m.hasTime ? formatWhen(m.start, timeZone) : `${formatWhen(m.start, timeZone).split(',').slice(0, 2).join(',')} (no time given)`;
    parts.push(
      `<p><b>Meeting ${m.agreed ? 'agreed' : 'mentioned'}:</b> ${escapeHtml(when)} ("${escapeHtml(m.phrase)}"). ` +
        `<a href="${escapeHtml(links.google)}">Add to Google Calendar</a> | <a href="${escapeHtml(links.outlook)}">Add to Outlook</a></p>`,
    );
  }

  parts.push(`<p><a href="${escapeHtml(talkUrl)}">Open UniFi Talk</a>${facts.hasRecording ? ' to play the recording' : ''}.</p>`);

  if (cls.lines.length) {
    const label = (speaker: string) => (speaker === cls.sides?.our ? ourLabel : speaker === cls.sides?.their ? 'Them' : speaker);
    const header = '<p><b>Transcript</b><br>';
    const budget = MAX_BODY - parts.join('').length - header.length - 200;
    let used = 0;
    const lines: string[] = [];
    for (const l of cls.lines) {
      const line = `${escapeHtml(label(l.speaker))}: ${escapeHtml(l.text)}`;
      if (used + line.length + 4 > budget) {
        lines.push('(transcript shortened to fit HubSpot)');
        break;
      }
      lines.push(line);
      used += line.length + 4;
    }
    parts.push(`${header}${lines.join('<br>')}</p>`);
  }
  return parts.join('\n');
}

export interface CallInput extends NotesInput {
  externalNumber: string | null;
  ourNumber: string | null;
  meetingBookedOutcomeId?: string;
}

/** POST /calls: the logged call, associated with the contact found or created first. */
export function createCall(input: CallInput): PlannedRequest {
  const { facts, cls } = input;
  const inbound = facts.direction === 'inbound';
  const who = input.externalNumber ? formatPhone(input.externalNumber, input.country) : 'unknown number';
  const properties: Record<string, string> = {
    hs_timestamp: facts.startedAt.toISOString(),
    hs_call_title: `${inbound ? 'Call from' : 'Call to'} ${who}`,
    hs_call_body: callNotes(input),
    hs_call_direction: inbound ? 'INBOUND' : 'OUTBOUND',
    hs_call_status: callStatus(facts),
    hs_call_duration: String(facts.talkSeconds * 1000),
    hs_call_external_id: facts.uuid,
    hubspot_owner_id: OWNER_ID,
  };
  if (cls.outcome) properties.hs_call_disposition = outcomeId(cls.outcome, input.meetingBookedOutcomeId);
  const from = inbound ? input.externalNumber : input.ourNumber;
  const to = inbound ? input.ourNumber : input.externalNumber;
  if (from) properties.hs_call_from_number = from;
  if (to) properties.hs_call_to_number = to;
  if (inbound && facts.voicemailLeft) properties.hs_call_has_voicemail = 'true';
  return {
    purpose: 'log the call',
    method: 'POST',
    path: `/crm/objects/${API_VERSION}/calls`,
    body: { properties, associations: contactAssociation(input.externalNumber, ASSOCIATION.callToContact) },
  };
}

/** Calls from withheld numbers can't be matched to a contact, so they are logged without one. */
function contactAssociation(externalNumber: string | null, associationTypeId: number) {
  return externalNumber ? [{ to: { id: CONTACT_ID }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId }] }] : [];
}

/**
 * The task that asks the rep to confirm the call. Outbound calls and answered inbound calls get one;
 * a missed inbound call gets one only if the caller left a voicemail.
 */
export function reviewTask(input: CallInput & { dueAt: Date }): PlannedRequest | null {
  const { facts, cls } = input;
  const who = input.externalNumber ? formatPhone(input.externalNumber, input.country) : 'unknown number';
  let subject: string;
  if (facts.direction === 'outbound') subject = `Confirm call outcome: ${cls.outcome ?? 'unknown'} (${who})`;
  else if (facts.answered) subject = `Confirm call details: call from ${who}`;
  else if (facts.voicemailLeft) subject = `Return call: ${who} left a voicemail`;
  else return null;
  const body = [
    `<p>Logged automatically from UniFi Talk on ${escapeHtml(formatWhen(facts.startedAt, input.timeZone))}.</p>`,
    cls.outcome ? `<p>Outcome picked: <b>${escapeHtml(cls.outcome)}</b> (${escapeHtml(cls.rule)}). Change it on the call if it's wrong.</p>` : '',
    cls.details.identities.length || cls.details.phones.length || cls.details.emails.length
      ? '<p>They mentioned details that may belong on the contact; see the call notes.</p>'
      : '',
    cls.details.meetings.some((m) => m.agreed) ? '<p>A meeting was agreed on the call; the call notes have calendar links.</p>' : '',
  ].filter(Boolean);
  return {
    purpose: 'ask the rep to confirm the call',
    method: 'POST',
    path: `/crm/objects/${API_VERSION}/tasks`,
    body: {
      properties: {
        hs_timestamp: input.dueAt.toISOString(),
        hs_task_subject: subject,
        hs_task_body: body.join('\n'),
        hs_task_status: 'NOT_STARTED',
        hs_task_priority: 'MEDIUM',
        hs_task_type: 'CALL',
        hubspot_owner_id: OWNER_ID,
      },
      associations: contactAssociation(input.externalNumber, ASSOCIATION.taskToContact),
    },
  };
}

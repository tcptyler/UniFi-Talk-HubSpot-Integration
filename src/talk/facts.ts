// What actually happened on a call, worked out from Talk's call events. The record's `status`
// field is not used: it differs between Talk versions and does not match the events one-to-one.
import type { CallRecord } from './schemas.ts';

export type CallDirection = 'inbound' | 'outbound' | 'internal';
export type CallStatus = 'in_progress' | 'answered' | 'busy' | 'no_answer';

export interface CallFacts {
  uuid: string;
  startedAt: Date;
  direction: CallDirection;
  status: CallStatus;
  /** Last `call_hangup` cause: normal_end, cancelled, refused (seen so far). */
  hangupCause: string | null;
  /** Seconds from answer to hang-up (0 when not answered). */
  talkSeconds: number;
  wentToVoicemail: boolean;
  /** The caller left a voicemail (inbound). */
  voicemailLeft: boolean;
  /** The outside party's number (E.164 as Talk stores it), when there is one. */
  externalNumber: string | null;
  /** Our number on the call (the DID dialled, or the caller ID we used). */
  ourNumber: string | null;
  /** Talk user who answered (inbound) or placed (outbound) the call. */
  userUuid: string | null;
  callerName: string | null;
  hasRecording: boolean;
}

const time = (iso: string) => Date.parse(iso);

export function callFacts(rec: CallRecord): CallFacts {
  const events = [...rec.call_events].sort((a, b) => time(a.time) - time(b.time));
  const first = (name: string) => events.find((e) => e.event === name);
  const accepted = first('call_accepted');
  const hangup = events.filter((e) => e.event === 'call_hangup').at(-1);
  const cause = typeof hangup?.event_data?.hangup_cause === 'string' ? hangup.event_data.hangup_cause : null;
  const direction: CallDirection = rec.direction === 'in' ? 'inbound' : rec.direction === 'out' ? 'outbound' : 'internal';
  const status: CallStatus = !hangup ? 'in_progress' : accepted ? 'answered' : cause === 'refused' ? 'busy' : 'no_answer';
  const acceptedBy = accepted?.event_data?.accepted_by_user_uuid;
  return {
    uuid: rec.uuid,
    startedAt: new Date(rec.time),
    direction,
    status,
    hangupCause: cause,
    talkSeconds: accepted && hangup ? Math.max(0, Math.round((time(hangup.time) - time(accepted.time)) / 1000)) : 0,
    wentToVoicemail: Boolean(first('call_sent_to_voicemail')),
    voicemailLeft: Boolean(first('vm_msg_recorded')),
    externalNumber: direction === 'inbound' ? (rec.from ?? null) : direction === 'outbound' ? (rec.to ?? null) : null,
    ourNumber: direction === 'inbound' ? (rec.to ?? null) : direction === 'outbound' ? (rec.from_did ?? null) : null,
    userUuid: direction === 'outbound' ? (rec.from_id ?? null) : (rec.answered_by_user_uuid ?? (typeof acceptedBy === 'string' ? acceptedBy : null)),
    callerName: direction === 'inbound' ? (rec.from_caller_name ?? null) : null,
    hasRecording: rec.recording === true,
  };
}

/** A call is ready to log once it has hung up, or after `staleAfterMs` with no hang-up (seen on real consoles). */
export function isReadyToLog(facts: CallFacts, now = Date.now(), staleAfterMs = 2 * 60 * 60_000): boolean {
  return facts.status !== 'in_progress' || now - facts.startedAt.getTime() > staleAfterMs;
}

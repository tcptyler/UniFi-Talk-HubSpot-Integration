// Plans what to do in HubSpot for one Talk call. Used by the dry run now and by the sync later,
// so both build the same requests.
import type { CallRecord, TalkNumber, TalkUser, Transcript } from '../talk/schemas.ts';
import { callFacts, isReadyToLog, type CallFacts } from '../talk/facts.ts';
import { classifyCall, type Classification, type Outcome } from '../rules/classify.ts';
import type { Rules } from '../rules/rules.ts';
import type { Self } from '../rules/extract.ts';
import { contactSearch, createCall, reviewTask, type PlannedRequest } from '../hubspot/calls.ts';
import { toE164, type CountryCode } from '../phone.ts';

export interface PlanContext {
  rules: Rules;
  self: Self;
  users: Map<string, TalkUser>;
  talkUrl: string;
  /** Include Talk's own call summary in the notes. */
  talkSummary: boolean;
  country: CountryCode;
  timeZone?: string;
  meetingBookedOutcomeId?: string;
  /** The review task is due this long after it is created. */
  taskDueMinutes?: number;
  now?: number;
}

export interface CallPlan {
  uuid: string;
  startedAt: string;
  action: 'log' | 'skip' | 'wait';
  reason: string;
  direction: CallFacts['direction'];
  status: CallFacts['status'];
  talkSeconds: number;
  outcome: Outcome | null;
  rule: string | null;
  evidence: string | null;
  sidesMethod: string | null;
  hasTranscript: boolean;
  externalNumber: string | null;
  /** Caller ID name from the phone network. A hint only: often a city or a carrier label. */
  callerIdName: string | null;
  talkUser: { uuid: string; name: string | null; email: string | null } | null;
  details: Classification['details'] | null;
  notes: string[];
  requests: PlannedRequest[];
}

export function userName(user: TalkUser | undefined): string | null {
  if (!user) return null;
  return user.full_name?.trim() || [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || null;
}

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com',
  'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'zoho.com', 'yandex.com', 'mail.com',
]);

/** Who "we" are, from Talk's users and numbers plus the company names in the config. */
export function selfFromTalk(users: TalkUser[], numbers: TalkNumber[], companies: string[], country: CountryCode): Self {
  const names = new Set<string>();
  const phones = new Set<string>();
  const domains = new Set<string>();
  const addPhone = (raw: unknown) => {
    const value = typeof raw === 'string' ? raw : raw && typeof raw === 'object' && 'did' in raw ? (raw as { did: unknown }).did : null;
    const e164 = typeof value === 'string' ? toE164(value, country) : null;
    if (e164) phones.add(e164);
  };
  for (const u of users) {
    const first = u.first_name?.trim() || userName(u)?.split(/\s+/)[0];
    if (first) names.add(first);
    addPhone(u.did);
    for (const d of u.did_list ?? []) addPhone(d);
    for (const email of [u.email, u.user_email]) {
      const domain = email?.split('@')[1]?.toLowerCase();
      if (domain && !FREE_MAIL.has(domain)) domains.add(domain);
    }
  }
  for (const n of numbers) addPhone(n.did);
  return { names: [...names], companies, numbers: [...phones], domains: [...domains] };
}

export function planCall(rec: CallRecord, transcript: Transcript | null, ctx: PlanContext): CallPlan {
  const now = ctx.now ?? Date.now();
  let facts = callFacts(rec);
  const user = facts.userUuid ? ctx.users.get(facts.userUuid) : undefined;
  const plan: CallPlan = {
    uuid: facts.uuid,
    startedAt: facts.startedAt.toISOString(),
    action: 'skip',
    reason: '',
    direction: facts.direction,
    status: facts.status,
    talkSeconds: facts.talkSeconds,
    outcome: null,
    rule: null,
    evidence: null,
    sidesMethod: null,
    hasTranscript: Boolean(transcript?.analytics?.lines.length),
    externalNumber: toE164(facts.externalNumber, ctx.country),
    callerIdName: facts.callerName,
    talkUser: facts.userUuid ? { uuid: facts.userUuid, name: userName(user), email: user?.email ?? user?.user_email ?? null } : null,
    details: null,
    notes: [],
    requests: [],
  };

  if (facts.direction === 'internal') return { ...plan, reason: 'internal call' };
  if (rec.is_intercom_call) return { ...plan, reason: 'intercom call' };
  if (facts.status === 'in_progress') {
    if (!isReadyToLog(facts, now)) return { ...plan, action: 'wait', reason: 'call not finished yet' };
    facts = { ...facts, status: facts.answered ? 'answered' : 'no_answer' };
    plan.notes.push('Talk never reported the end of this call, so it is logged as it stood.');
  }

  const firstName = user?.first_name?.trim() || userName(user)?.split(/\s+/)[0] || undefined;
  const cls = classifyCall(facts, transcript, {
    rules: ctx.rules,
    self: ctx.self,
    userNames: firstName ? [firstName] : undefined,
    defaultCountry: ctx.country,
    timeZone: ctx.timeZone,
  });
  const input = {
    facts,
    cls,
    talkUrl: ctx.talkUrl,
    summary: ctx.talkSummary ? (transcript?.analytics?.summary ?? null) : null,
    ourLabel: firstName ?? 'Us',
    timeZone: ctx.timeZone,
    country: ctx.country,
    externalNumber: plan.externalNumber,
    ourNumber: toE164(facts.ourNumber, ctx.country) ?? facts.ourNumber,
    meetingBookedOutcomeId: ctx.meetingBookedOutcomeId,
  };
  if (!plan.externalNumber) plan.notes.push('No usable caller number, so the call is logged without a contact.');
  if (cls.outcome === 'Meeting booked' && !ctx.meetingBookedOutcomeId) {
    plan.notes.push('No custom "Meeting booked" outcome is set up, so the call is marked Connected and the notes say a meeting was agreed.');
  }
  const endedAt = facts.startedAt.getTime() + facts.talkSeconds * 1000;
  const dueAt = new Date(Math.max(now, endedAt) + (ctx.taskDueMinutes ?? 30) * 60_000);
  const task = reviewTask({ ...input, dueAt });
  return {
    ...plan,
    action: 'log',
    reason: cls.rule,
    status: facts.status,
    outcome: cls.outcome,
    rule: cls.rule,
    evidence: cls.evidence,
    sidesMethod: cls.sides?.method ?? null,
    details: cls.details,
    requests: [...(plan.externalNumber ? [contactSearch(plan.externalNumber)] : []), createCall(input), ...(task ? [task] : [])],
  };
}

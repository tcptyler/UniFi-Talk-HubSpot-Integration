// Dry run over recent calls: reads Talk, plans every HubSpot request, writes nothing to HubSpot.
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';
import type { Rules } from '../rules/rules.ts';
import { TalkAuthError, TalkRateLimitError, type TalkClient } from '../talk/client.ts';
import type { CallRecord, Transcript } from '../talk/schemas.ts';
import { callFacts } from '../talk/facts.ts';
import { toCountry, type CountryCode } from '../phone.ts';
import { HubSpotAuthError, HubSpotClient } from '../hubspot/client.ts';
import { loadHubSpotContext, matchPlan, type HubSpotContext } from '../hubspot/lookup.ts';
import { planCall, selfFromTalk, type CallPlan } from './plan.ts';

export interface PreviewOptions {
  hours: number;
  limit: number;
  now?: number;
}

export interface PreviewResult {
  plans: CallPlan[];
  talkVersion: string;
  country: CountryCode;
  transcriptErrors: number;
  /** The time zone used: TIME_ZONE, else the HubSpot portal's, else the server's (undefined). */
  timeZone: string | undefined;
  /** Read-only HubSpot results; null without a Service Key. */
  hubspot: { portalId: number; problem: string | null; lookupErrors: number; meetingBookedOutcome: string | null; timeZone: string | null } | null;
}

export async function preview(talk: TalkClient, config: Config, rules: Rules, options: PreviewOptions): Promise<PreviewResult> {
  const now = options.now ?? Date.now();

  // HubSpot first (read only), so a custom "Meeting booked" outcome and the portal's time zone can be used.
  let hs: HubSpotContext | null = null;
  let hubspot: PreviewResult['hubspot'] = null;
  const client = config.hubspot.token ? new HubSpotClient({ token: config.hubspot.token, baseUrl: config.hubspot.baseUrl }) : null;
  if (client) {
    try {
      hs = await loadHubSpotContext(client);
      hubspot = { portalId: hs.account.portalId, problem: null, lookupErrors: 0, meetingBookedOutcome: hs.meetingBookedOutcome?.label ?? null, timeZone: hs.account.timeZone ?? null };
    } catch (err) {
      if (!(err instanceof HubSpotAuthError)) throw err;
      hubspot = { portalId: 0, problem: err.message, lookupErrors: 0, meetingBookedOutcome: null, timeZone: null };
    }
  }

  const info = await talk.info();
  const country = toCountry(config.defaultCountry ?? info.default_country);
  const users = await talk.users();
  const numbers = await talk.numbers();
  const ctx = {
    rules,
    self: selfFromTalk(users, numbers, config.companyNames, country),
    users: new Map(users.map((u) => [u.unique_id, u])),
    talkUrl: config.talk.url,
    talkSummary: config.features.talkSummary,
    country,
    timeZone: config.timeZone ?? hs?.account.timeZone ?? undefined,
    meetingBookedOutcomeId: config.hubspot.meetingBookedOutcomeId ?? hs?.meetingBookedOutcome?.id,
    now,
  };
  const records = await recentCalls(talk, now - options.hours * 3_600_000, options.limit);
  const plans: CallPlan[] = [];
  let transcriptErrors = 0;
  for (const rec of records.reverse()) {
    const facts = callFacts(rec);
    let transcript: Transcript | null = null;
    if (facts.direction !== 'internal' && facts.answered && facts.status !== 'in_progress') {
      try {
        transcript = await talk.transcriptForCall(rec.uuid);
      } catch (err) {
        if (err instanceof TalkAuthError || err instanceof TalkRateLimitError) throw err;
        transcriptErrors++;
      }
    }
    plans.push(planCall(rec, transcript, ctx));
  }

  if (client && hs && hubspot) {
    const cache = new Map();
    for (const plan of plans.filter((p) => p.action === 'log')) {
      try {
        plan.hubspot = await matchPlan(client, hs, plan, cache);
      } catch (err) {
        if (err instanceof HubSpotAuthError) {
          hubspot.problem = err.message;
          break;
        }
        hubspot.lookupErrors++;
      }
    }
  }
  return { plans, talkVersion: info.version, country, transcriptErrors, timeZone: ctx.timeZone, hubspot };
}

/** Newest calls first, back to `fromMs`, at most `limit`. */
async function recentCalls(talk: TalkClient, fromMs: number, limit: number): Promise<CallRecord[]> {
  const perPage = Math.min(100, limit);
  const out: CallRecord[] = [];
  for (let page = 0; out.length < limit; page++) {
    const res = await talk.callLogPage({ page, itemsPerPage: perPage, fromMs });
    out.push(...res.records.filter((r) => Date.parse(r.time) >= fromMs)); // in case the console ignores from_time
    if (res.records.length < perPage || out.length >= res.total_count || res.records.some((r) => Date.parse(r.time) < fromMs)) break;
  }
  return out.slice(0, limit);
}

/** The full plan, one JSON line per call. It holds numbers and transcripts, so only the owner can read it. */
export function writePlans(plans: CallPlan[], dataDir: string, now = new Date()): string {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = path.join(dataDir, `preview-${stamp}.jsonl`);
  fs.writeFileSync(file, plans.map((p) => JSON.stringify(p)).join('\n') + '\n', { mode: 0o600 });
  return file;
}

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
const duration = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`);

/** A summary for the terminal. No numbers, names or transcript words, so it is safe to share. */
export function summarize(result: PreviewResult, options: { hours: number }): string {
  const { plans } = result;
  const when = new Intl.DateTimeFormat('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: result.timeZone });
  const rows = plans.map((p) => {
    const flags = [p.hasTranscript && 'T', p.details?.identities.length || p.details?.phones.length || p.details?.emails.length ? 'D' : '', p.details?.meetings.length ? 'M' : '']
      .filter(Boolean)
      .join('');
    const dir = p.direction === 'inbound' ? 'in' : p.direction === 'outbound' ? 'out' : 'int';
    const outcome = p.action === 'log' ? (p.outcome ?? '-') : p.action === 'wait' ? '(waiting)' : '(skipped)';
    return [pad(when.format(new Date(p.startedAt)), 14), pad(dir, 4), pad(p.status, 11), pad(duration(p.talkSeconds), 7), pad(outcome, 18), pad(p.reason, 52), flags].join(' ');
  });
  const count = <T extends string>(values: T[]) =>
    Object.entries(values.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {}))
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(', ');
  const logged = plans.filter((p) => p.action === 'log');
  const tasks = logged.filter((p) => p.requests.some((r) => r.path.endsWith('/tasks'))).length;
  const lines = [
    `Preview of the last ${options.hours} h: ${plans.length} calls on Talk ${result.talkVersion}. Nothing was written to HubSpot.`,
    '',
    [pad('When', 14), pad('Dir', 4), pad('Status', 11), pad('Talk', 7), pad('Outcome', 18), pad('Why', 52), 'T=transcript D=details M=meeting'].join(' '),
    ...rows,
    '',
    `Would log ${logged.length} calls${logged.length ? ` (${count(logged.map((p) => p.outcome ?? 'none'))})` : ''} and create ${tasks} review tasks.`,
  ];
  const skipped = plans.filter((p) => p.action === 'skip');
  if (skipped.length) lines.push(`Skipped ${skipped.length} (${count(skipped.map((p) => p.reason))}).`);
  const waiting = plans.filter((p) => p.action === 'wait').length;
  if (waiting) lines.push(`Waiting on ${waiting} unfinished call${waiting === 1 ? '' : 's'}.`);
  const sides = logged.map((p) => p.sidesMethod).filter((m): m is string => Boolean(m));
  if (sides.length) lines.push(`Speaker sides decided by: ${count(sides)}.`);
  const errors = result.transcriptErrors;
  if (errors) lines.push(`${errors} transcript${errors === 1 ? '' : 's'} could not be read; ${errors === 1 ? 'that call was' : 'those calls were'} planned from call events only.`);

  const hs = result.hubspot;
  if (!hs) {
    lines.push('', 'HubSpot: no Service Key set, so contacts and owners were not looked up.');
  } else if (hs.problem && !hs.portalId) {
    lines.push('', `HubSpot: ${hs.problem}. Contacts and owners were not looked up.`);
  } else {
    const matched = logged.filter((p) => p.hubspot);
    const numbers = new Map(matched.filter((p) => p.externalNumber).map((p) => [p.externalNumber!, p.hubspot!.contactIds.length]));
    const known = [...numbers.values()].filter((n) => n > 0).length;
    const dupes = [...numbers.values()].filter((n) => n > 1).length;
    const already = matched.filter((p) => p.hubspot!.existingCallId).length;
    const owners = count(matched.map((p) => p.hubspot!.ownerSource ?? 'no owner found'));
    lines.push(
      '',
      `HubSpot (read only, portal ${hs.portalId}): ${known} of ${numbers.size} caller numbers match a contact; ${numbers.size - known} would be new contacts${dupes ? `; ${dupes} match more than one contact` : ''}.`,
      `Owners: ${owners || 'none'}. Already logged in HubSpot: ${already}.`,
      hs.meetingBookedOutcome ? `Custom outcome "${hs.meetingBookedOutcome}" found and used for booked meetings.` : 'No custom "Meeting booked" outcome; booked meetings would be logged as Connected.',
    );
    if (hs.problem) lines.push(`Stopped looking up: ${hs.problem}.`);
    if (hs.lookupErrors) lines.push(`${hs.lookupErrors} lookups failed and were skipped.`);
  }
  return lines.join('\n');
}

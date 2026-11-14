// The sync: every poll, read new calls from Talk and log each finished external call in HubSpot once.
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';
import type { Rules } from '../rules/rules.ts';
import { TalkAuthError, TalkRateLimitError, TalkSchemaError, type TalkClient } from '../talk/client.ts';
import type { TalkNumber, TalkUser, Transcript } from '../talk/schemas.ts';
import { callFacts, isReadyToLog } from '../talk/facts.ts';
import { toCountry, type CountryCode } from '../phone.ts';
import { HubSpotAuthError, type HubSpotClient } from '../hubspot/client.ts';
import type { HubSpotContext } from '../hubspot/lookup.ts';
import { planCall, selfFromTalk, type PlanContext } from './plan.ts';
import { recentCalls } from './preview.ts';
import { executePlan, hubspotWriter, recordingWriter, type ExecuteOptions } from './execute.ts';
import type { Store } from './store.ts';

export interface Log {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface SyncDeps {
  talk: TalkClient;
  config: Config;
  rules: Rules;
  store: Store;
  hubspot: { client: HubSpotClient; context: HubSpotContext } | null;
  log: Log;
}

export interface SyncSummary {
  seen: number;
  logged: number;
  alreadyLogged: number;
  skipped: number;
  waiting: number;
  failed: number;
}

/** Calls are re-read this far back each poll, so nothing slips through between polls. */
const OVERLAP_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const DIRECTORY_REFRESH_MS = 15 * 60_000;

/** Errors that need a person (expired sign-in, refused key, Talk changed shape): the sync stops on these. */
export const isFatal = (err: unknown) => err instanceof TalkAuthError || err instanceof HubSpotAuthError || err instanceof TalkSchemaError;

export class Syncer {
  readonly deps: SyncDeps;
  #directory: { at: number; users: TalkUser[]; numbers: TalkNumber[]; country: CountryCode } | null = null;

  constructor(deps: SyncDeps) {
    this.deps = deps;
  }

  async once(now = Date.now()): Promise<SyncSummary> {
    const { talk, config, rules, store, hubspot, log } = this.deps;
    const dryRun = config.dryRun;
    if (!this.#directory || now - this.#directory.at > DIRECTORY_REFRESH_MS) {
      const info = await talk.info();
      const users = await talk.users();
      const numbers = await talk.numbers();
      this.#directory = { at: now, users, numbers, country: toCountry(config.defaultCountry ?? info.default_country) };
    }
    const { users, numbers, country } = this.#directory;
    const ctx: PlanContext = {
      rules,
      self: selfFromTalk(users, numbers, config.companyNames, country),
      users: new Map(users.map((u) => [u.unique_id, u])),
      talkUrl: config.talk.url,
      talkSummary: config.features.talkSummary,
      country,
      timeZone: config.timeZone ?? hubspot?.context.account.timeZone ?? undefined,
      meetingBookedOutcomeId: config.hubspot.meetingBookedOutcomeId ?? hubspot?.context.meetingBookedOutcome?.id,
      now,
    };
    const defaultOwnerEmail = config.sync.defaultOwnerEmail?.toLowerCase();
    const execOptions: ExecuteOptions = {
      autoFill: config.sync.autoFill,
      minTalkSecondsForNewContact: config.sync.newContactMinTalkSeconds,
      defaultOwnerId: defaultOwnerEmail ? hubspot?.context.ownersByEmail.get(defaultOwnerEmail)?.id : undefined,
    };

    store.cursorMs ??= now - config.sync.backfillHours * 3_600_000;
    const records = (await recentCalls(talk, store.cursorMs - OVERLAP_MS, 500)).reverse(); // oldest first
    const summary: SyncSummary = { seen: records.length, logged: 0, alreadyLogged: 0, skipped: 0, waiting: 0, failed: 0 };
    let keepFrom: number | null = null; // the oldest call still to do, so the next poll reads it again
    const keep = (t: number) => (keepFrom = Math.min(keepFrom ?? t, t));

    for (const rec of records) {
      const done = store.get(rec.uuid, dryRun);
      if (done && (done.result !== 'failed' || (done.attempts ?? 0) >= MAX_ATTEMPTS)) continue;
      const facts = callFacts(rec);
      const started = facts.startedAt.getTime();

      if (facts.direction !== 'internal' && facts.status === 'in_progress' && !isReadyToLog(facts, now)) {
        summary.waiting++;
        keep(started);
        continue;
      }
      let transcript: Transcript | null = null;
      if (facts.direction !== 'internal' && facts.answered) {
        try {
          transcript = await talk.transcriptForCall(rec.uuid);
        } catch (err) {
          if (isFatal(err) || err instanceof TalkRateLimitError) throw err;
          log.warn({ call: rec.uuid, err: (err as Error).message }, 'transcript could not be read');
        }
        const complete = transcript !== null && /complete/i.test(transcript.status);
        const endedAt = facts.endedAt?.getTime() ?? started;
        if (!complete && now - endedAt < config.sync.transcriptWaitMinutes * 60_000) {
          summary.waiting++; // Talk usually finishes the transcript one to three minutes after the call
          keep(started);
          continue;
        }
      }

      const plan = planCall(rec, transcript, ctx);
      const at = new Date(now).toISOString();
      try {
        if (!hubspot) {
          // Dry run without a HubSpot key: record what would be sent, unresolved.
          appendDryRun(config.dataDir, now, { call: plan.uuid, outcome: plan.outcome, result: plan.action === 'log' ? 'would log' : 'skipped', reason: plan.reason, requests: plan.requests });
          store.set(plan.uuid, { result: plan.action === 'log' ? 'logged' : 'skipped', at, reason: plan.reason }, true);
          if (plan.action === 'log') summary.logged++;
          else summary.skipped++;
          continue;
        }
        const writer = dryRun ? recordingWriter() : hubspotWriter(hubspot.client);
        const r = await executePlan(hubspot.client, writer, hubspot.context, plan, execOptions);
        if (dryRun && 'writes' in writer) appendDryRun(config.dataDir, now, { call: plan.uuid, outcome: plan.outcome, result: r.result, reason: r.reason, writes: writer.writes });
        store.set(plan.uuid, { result: r.result, at, reason: r.reason, callId: r.callId, taskId: r.taskId }, dryRun);
        if (r.result === 'logged') summary.logged++;
        else if (r.result === 'already logged') summary.alreadyLogged++;
        else summary.skipped++;
        // No numbers or names in the logs.
        log.info(
          { call: plan.uuid, direction: plan.direction, outcome: plan.outcome, result: r.result, reason: r.reason, callId: r.callId, taskId: r.taskId, contactCreated: r.contactCreated, filled: r.filled, ...(r.taskError ? { taskError: r.taskError } : {}), dryRun },
          'call processed',
        );
      } catch (err) {
        if (isFatal(err) || err instanceof TalkRateLimitError) throw err;
        const attempts = (done?.attempts ?? 0) + 1;
        store.set(plan.uuid, { result: 'failed', at, reason: (err as Error).message, attempts }, dryRun);
        log.error({ call: plan.uuid, attempts, err: (err as Error).message }, attempts >= MAX_ATTEMPTS ? 'call failed; giving up on it' : 'call failed; will retry');
        summary.failed++;
        if (attempts < MAX_ATTEMPTS) keep(started);
      }
    }
    store.cursorMs = keepFrom ?? now;
    store.save(now);
    return summary;
  }
}

function appendDryRun(dataDir: string, now: number, entry: object): void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, `dry-run-${new Date(now).toISOString().slice(0, 10)}.jsonl`);
  fs.appendFileSync(file, JSON.stringify({ at: new Date(now).toISOString(), ...entry }) + '\n', { mode: 0o600 });
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/** Polls until stopped. Stops (throws) only on errors that need a person; waits out rate limits. */
export async function runLoop(syncer: Syncer, options: { pollSeconds: number; signal: AbortSignal; log: Log }): Promise<void> {
  const { pollSeconds, signal, log } = options;
  while (!signal.aborted) {
    try {
      const s = await syncer.once();
      if (s.logged || s.failed || s.alreadyLogged) log.info({ ...s }, 'poll');
    } catch (err) {
      if (isFatal(err)) throw err;
      if (err instanceof TalkRateLimitError) {
        log.warn({ until: err.retryAt.toISOString() }, 'console asked us to slow down; waiting');
        await sleep(Math.max(0, err.retryAt.getTime() - Date.now()), signal);
        continue;
      }
      log.warn({ err: (err as Error).message }, 'poll failed; trying again next time'); // console rebooting, network blip
    }
    await sleep(pollSeconds * 1000, signal);
  }
}

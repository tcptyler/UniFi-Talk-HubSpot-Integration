#!/usr/bin/env node
// Command line entry point. Output never includes credentials, phone numbers or names.
import { parseArgs } from 'node:util';
import { loadConfig, ConfigError } from './config.ts';
import { fetchCertificate } from './talk/tls.ts';
import { TalkClient, TalkAuthError, TalkError, TalkRateLimitError, TalkSchemaError } from './talk/client.ts';
import { callFacts } from './talk/facts.ts';
import { loadRules, RulesError, DEFAULT_RULES_FILE } from './rules/rules.ts';
import { preview, summarize, writePlans } from './sync/preview.ts';

const HELP = `unifi-talk-hubspot: log UniFi Talk calls in HubSpot (self-hosted, no AI)

Usage:
  unifi-talk-hubspot fingerprint <host>[:port]   Show the console's certificate fingerprint (for TALK_CERT_SHA256)
  unifi-talk-hubspot check                       Check the configuration and the connection to Talk
  unifi-talk-hubspot preview [--hours 24] [--limit 200]
                                                 Show what would be logged in HubSpot for recent calls.
                                                 Writes nothing to HubSpot.
  unifi-talk-hubspot help                        Show this help

Configuration comes from environment variables (see .env.example) or config.yaml.
`;

const EXIT = { ok: 0, usage: 64, config: 78, auth: 77, unavailable: 69, software: 70 } as const;

async function fingerprint(target: string | undefined): Promise<number> {
  if (!target) {
    console.error('usage: unifi-talk-hubspot fingerprint <host>[:port]');
    return EXIT.usage;
  }
  const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(target.replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
  const host = m?.[1] ?? target;
  const port = m?.[2] ? Number(m[2]) : 443;
  const cert = await fetchCertificate(host, port);
  console.log(`Certificate presented by ${host}:${port}`);
  console.log(`  subject:    ${cert.subject ?? '(none)'}`);
  console.log(`  issuer:     ${cert.issuer ?? '(none)'}${cert.selfSigned ? ' (self-signed)' : ''}`);
  console.log(`  valid:      ${cert.validFrom} to ${cert.validTo}`);
  console.log(`  SHA-256:    ${cert.sha256}`);
  console.log('');
  console.log('If this is your console, add this line to your .env:');
  console.log(`TALK_CERT_SHA256=${cert.sha256}`);
  console.log('');
  console.log('Check it matches the certificate your browser shows for the console before trusting it.');
  return EXIT.ok;
}

async function check(): Promise<number> {
  const config = loadConfig();
  const talk = new TalkClient({ host: config.talk.host, port: config.talk.port, pin: config.talk.certSha256, auth: config.talk.auth });
  console.log(`Talk console ${config.talk.host}:${config.talk.port}, signing in with: ${config.talk.auth.kind}`);
  const info = await talk.info();
  console.log(`  Talk version ${info.version}${info.update_channel ? ` (${info.update_channel} channel)` : ''}`);
  const [users, numbers, page] = await Promise.all([talk.users(), talk.numbers(), talk.callLogPage({ itemsPerPage: 25 })]);
  console.log(`  ${users.length} Talk users, ${numbers.length} numbers (${numbers.filter((n) => n.sms_enabled).length} with SMS)`);
  const facts = page.records.map(callFacts);
  const external = facts.filter((f) => f.direction !== 'internal').length;
  const newest = facts[0]?.startedAt.toISOString() ?? 'none';
  console.log(`  call log: ${page.total_count} calls; newest ${newest}; ${external} of the latest ${facts.length} are external`);
  console.log(`HubSpot: ${config.hubspot.token ? 'token set' : 'no token (dry-run only)'}; mode: ${config.dryRun ? 'dry run' : 'write'}`);
  talk.agent.destroy();
  return EXIT.ok;
}

async function runPreview(args: { hours?: string | boolean; limit?: string | boolean }): Promise<number> {
  const hours = Number(args.hours ?? 24);
  const limit = Number(args.limit ?? 200);
  if (!Number.isFinite(hours) || hours <= 0 || !Number.isInteger(limit) || limit <= 0) {
    console.error('usage: unifi-talk-hubspot preview [--hours <number>] [--limit <whole number>]');
    return EXIT.usage;
  }
  const config = loadConfig();
  const rules = loadRules(config.rulesFile ?? DEFAULT_RULES_FILE);
  const talk = new TalkClient({ host: config.talk.host, port: config.talk.port, pin: config.talk.certSha256, auth: config.talk.auth });
  try {
    const result = await preview(talk, config, rules, { hours, limit });
    console.log(summarize(result, { hours, timeZone: config.timeZone }));
    const file = writePlans(result.plans, config.dataDir);
    console.log(`\nFull plan, with the exact HubSpot requests: ${file}`);
    console.log('It contains phone numbers and transcripts; keep it private.');
    return EXIT.ok;
  } finally {
    talk.agent.destroy();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: { hours: { type: 'string' }, limit: { type: 'string' } },
  });
  const [command, ...rest] = positionals;
  try {
    switch (command) {
      case 'fingerprint':
        return await fingerprint(rest[0]);
      case 'check':
        return await check();
      case 'preview':
        return await runPreview(values);
      case undefined:
      case 'help':
        console.log(HELP);
        return EXIT.ok;
      default:
        console.error(`unknown command: ${command}\n\n${HELP}`);
        return EXIT.usage;
    }
  } catch (err) {
    if (err instanceof ConfigError || err instanceof RulesError) {
      console.error(err.message);
      return EXIT.config;
    }
    if (err instanceof TalkAuthError) {
      console.error(`Talk sign-in failed: ${err.message}`);
      return EXIT.auth;
    }
    if (err instanceof TalkRateLimitError || err instanceof TalkSchemaError || err instanceof TalkError) {
      console.error(err.message);
      return EXIT.unavailable;
    }
    const e = err as NodeJS.ErrnoException;
    if (e?.code && /^(ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|ECONNRESET)$/.test(e.code)) {
      console.error(`can't reach the console: ${e.code}`);
      return EXIT.unavailable;
    }
    if (e instanceof Error && /pinned fingerprint/.test(e.message)) {
      console.error(`${e.message}. If the console's certificate was replaced, run \`unifi-talk-hubspot fingerprint\` and update TALK_CERT_SHA256.`);
      return EXIT.unavailable;
    }
    console.error(err);
    return EXIT.software;
  }
}

if (import.meta.main) {
  // Load ./.env when present. Variables already set in the environment win.
  try {
    process.loadEnvFile('.env');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  process.exitCode = await main();
}

// Configuration: environment variables first, then an optional YAML file, then defaults.
// Any secret can instead be read from a file by setting <NAME>_FILE (for Docker secrets).
// Error messages name the setting, never its value.
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { normalizeFingerprint } from './talk/tls.ts';
import type { TalkAuth } from './talk/client.ts';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const bool = z.union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])]).transform((v) => v === true || v === 'true' || v === '1' || v === 'yes' || v === 'on');

const ConfigSchema = z.object({
  talk: z.object({
    host: z
      .string({ error: 'TALK_HOST is required (the console address, for example 192.168.1.1)' })
      .trim()
      .min(1, 'TALK_HOST is required (the console address, for example 192.168.1.1)'),
    port: z.coerce.number().int().min(1).max(65535).default(443),
    certSha256: z
      .string({ error: 'TALK_CERT_SHA256 is required; run `unifi-talk-hubspot fingerprint <host>` to get it' })
      .transform(normalizeFingerprint)
      .refine((v) => v.length === 64, 'TALK_CERT_SHA256 must be a SHA-256 fingerprint (64 hex characters)'),
    auth: z.enum(['apiKey', 'localAccount', 'sessionToken']).optional(),
    apiKey: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    sessionToken: z.string().min(1).optional(),
    pollSeconds: z.coerce.number().int().min(15, 'TALK_POLL_SECONDS must be at least 15').default(60),
  }),
  hubspot: z.object({
    token: z.string().min(1).optional(),
  }),
  dryRun: bool.default(true),
  dataDir: z.string().min(1).default('./data'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  features: z.object({
    /** Put Talk's own AI call summary in the HubSpot call notes (admins can turn it off). */
    talkSummary: bool.default(true),
  }),
});

type ParsedConfig = z.infer<typeof ConfigSchema>;

export interface Config extends Omit<ParsedConfig, 'talk'> {
  talk: { host: string; port: number; certSha256: string; pollSeconds: number; auth: TalkAuth };
}

/** Environment variable → config path. Secrets are marked so `<NAME>_FILE` works and values are never echoed. */
const ENV: Array<{ name: string; path: string; secret?: boolean }> = [
  { name: 'TALK_HOST', path: 'talk.host' },
  { name: 'TALK_PORT', path: 'talk.port' },
  { name: 'TALK_CERT_SHA256', path: 'talk.certSha256' },
  { name: 'TALK_AUTH', path: 'talk.auth' },
  { name: 'TALK_API_KEY', path: 'talk.apiKey', secret: true },
  { name: 'TALK_USERNAME', path: 'talk.username' },
  { name: 'TALK_PASSWORD', path: 'talk.password', secret: true },
  { name: 'TALK_SESSION_TOKEN', path: 'talk.sessionToken', secret: true },
  { name: 'TALK_POLL_SECONDS', path: 'talk.pollSeconds' },
  { name: 'HUBSPOT_TOKEN', path: 'hubspot.token', secret: true },
  { name: 'DRY_RUN', path: 'dryRun' },
  { name: 'DATA_DIR', path: 'dataDir' },
  { name: 'LOG_LEVEL', path: 'logLevel' },
  { name: 'TALK_SUMMARY', path: 'features.talkSummary' },
];

export const SECRET_PATHS = new Set(ENV.filter((e) => e.secret).map((e) => e.path));

function setPath(target: Record<string, unknown>, dotted: string, value: unknown): void {
  const keys = dotted.split('.');
  let node = target;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    node = (next && typeof next === 'object' ? next : (node[key] = {})) as Record<string, unknown>;
  }
  node[keys.at(-1)!] = value;
}

function readSecretFile(name: string, file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    throw new ConfigError(`${name}_FILE points to a file that can't be read (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  /** YAML file; defaults to CONFIG_FILE, else ./config.yaml when it exists. */
  file?: string;
  cwd?: string;
}

export function loadConfig(options: LoadOptions = {}): Config {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const raw: Record<string, unknown> = { talk: {}, hubspot: {}, features: {} };

  const file = options.file ?? env.CONFIG_FILE ?? (fs.existsSync(path.join(cwd, 'config.yaml')) ? 'config.yaml' : undefined);
  if (file) {
    let text: string;
    try {
      text = fs.readFileSync(path.resolve(cwd, file), 'utf8');
    } catch {
      throw new ConfigError(`config file ${file} can't be read`);
    }
    const yaml = parseYaml(text) as unknown;
    if (yaml !== null && (typeof yaml !== 'object' || Array.isArray(yaml))) throw new ConfigError(`config file ${file} must be a YAML mapping`);
    for (const [key, value] of Object.entries((yaml ?? {}) as Record<string, unknown>)) {
      raw[key] = value && typeof value === 'object' && !Array.isArray(value) ? { ...(raw[key] as object), ...value } : value;
    }
  }

  for (const { name, path: dotted, secret } of ENV) {
    const fromFile = secret ? env[`${name}_FILE`] : undefined;
    const value = fromFile ? readSecretFile(name, fromFile) : env[name];
    if (value !== undefined && value !== '') setPath(raw, dotted, value);
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => {
      const where = issue.path.join('.');
      // Our own messages already name the setting; for zod's generic ones, prefix the setting name.
      const setting = ENV.find((e) => e.path === where)?.name ?? where;
      if (issue.message.includes(setting) || issue.code === 'custom') return issue.message;
      return `${setting}: ${SECRET_PATHS.has(where) ? 'invalid value' : issue.message}`;
    });
    throw new ConfigError(`configuration problems:\n  - ${lines.join('\n  - ')}`);
  }
  const c = parsed.data;
  return { ...c, talk: { host: c.talk.host, port: c.talk.port, certSha256: c.talk.certSha256, pollSeconds: c.talk.pollSeconds, auth: talkAuth(c.talk) } };
}

/** Which way to sign in: TALK_AUTH if set, else whichever credentials are present (API key first). */
function talkAuth(t: ParsedConfig['talk']): TalkAuth {
  const kind = t.auth ?? (t.apiKey ? 'apiKey' : t.username || t.password ? 'localAccount' : t.sessionToken ? 'sessionToken' : undefined);
  switch (kind) {
    case 'apiKey':
      if (!t.apiKey) throw new ConfigError('TALK_AUTH is apiKey but TALK_API_KEY is not set');
      return { kind, apiKey: t.apiKey };
    case 'localAccount':
      if (!t.username || !t.password) throw new ConfigError('signing in with a local account needs both TALK_USERNAME and TALK_PASSWORD');
      return { kind, username: t.username, password: t.password };
    case 'sessionToken':
      if (!t.sessionToken) throw new ConfigError('TALK_AUTH is sessionToken but TALK_SESSION_TOKEN is not set');
      return { kind, token: t.sessionToken };
    default:
      throw new ConfigError('no Talk sign-in configured: set TALK_API_KEY, or TALK_USERNAME and TALK_PASSWORD');
  }
}

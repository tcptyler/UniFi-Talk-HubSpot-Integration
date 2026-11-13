import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ConfigError } from '../src/config.ts';

const PIN = 'AB:'.repeat(31) + 'AB';
const base = { TALK_HOST: '192.0.2.10', TALK_CERT_SHA256: PIN };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uth-config-'));
const load = (env: Record<string, string>, file?: string) => loadConfig({ env, cwd: tmp, file });

test('defaults: dry run, port 443, poll every 60 s, Talk summary on', () => {
  const c = load({ ...base, TALK_API_KEY: 'k' });
  assert.equal(c.dryRun, true);
  assert.equal(c.talk.port, 443);
  assert.equal(c.talk.pollSeconds, 60);
  assert.equal(c.features.talkSummary, true);
  assert.equal(c.talk.certSha256, 'ab'.repeat(32));
});

test('sign-in method is inferred from the credentials present, API key first', () => {
  assert.equal(load({ ...base, TALK_API_KEY: 'k', TALK_USERNAME: 'u', TALK_PASSWORD: 'p' }).talk.auth.kind, 'apiKey');
  assert.deepEqual(load({ ...base, TALK_USERNAME: 'u', TALK_PASSWORD: 'p' }).talk.auth, { kind: 'localAccount', username: 'u', password: 'p' });
  assert.equal(load({ ...base, TALK_SESSION_TOKEN: 't' }).talk.auth.kind, 'sessionToken');
  assert.equal(load({ ...base, TALK_AUTH: 'sessionToken', TALK_SESSION_TOKEN: 't', TALK_API_KEY: 'k' }).talk.auth.kind, 'sessionToken');
});

test('missing or half-set credentials are explained', () => {
  assert.throws(() => load(base), /no Talk sign-in configured/);
  assert.throws(() => load({ ...base, TALK_USERNAME: 'u' }), /TALK_USERNAME and TALK_PASSWORD/);
  assert.throws(() => load({ ...base, TALK_AUTH: 'apiKey' }), /TALK_API_KEY is not set/);
});

test('secrets can come from files (Docker secrets)', () => {
  const file = path.join(tmp, 'api_key');
  fs.writeFileSync(file, 'from-file\n');
  const c = load({ ...base, TALK_API_KEY_FILE: file });
  assert.deepEqual(c.talk.auth, { kind: 'apiKey', apiKey: 'from-file' });
  assert.throws(() => load({ ...base, TALK_API_KEY_FILE: path.join(tmp, 'missing') }), /TALK_API_KEY_FILE points to a file that can't be read/);
});

test('YAML file is merged under environment variables', () => {
  fs.writeFileSync(path.join(tmp, 'c.yaml'), 'talk:\n  host: 192.0.2.99\n  pollSeconds: 30\ndryRun: false\nfeatures:\n  talkSummary: false\n');
  const c = load({ TALK_CERT_SHA256: PIN, TALK_API_KEY: 'k', TALK_HOST: '192.0.2.10' }, 'c.yaml');
  assert.equal(c.talk.host, '192.0.2.10', 'env wins');
  assert.equal(c.talk.pollSeconds, 30);
  assert.equal(c.dryRun, false);
  assert.equal(c.features.talkSummary, false);
});

test('bad values are reported by setting name, and secret values are never echoed', () => {
  const err = (() => {
    try {
      load({ TALK_CERT_SHA256: 'nope', TALK_API_KEY: 'k', TALK_POLL_SECONDS: '5', DRY_RUN: 'maybe' });
    } catch (e) {
      return e;
    }
  })();
  assert.ok(err instanceof ConfigError);
  assert.match(err.message, /TALK_HOST is required/);
  assert.match(err.message, /TALK_CERT_SHA256 must be a SHA-256 fingerprint/);
  assert.match(err.message, /TALK_POLL_SECONDS must be at least 15/);
  assert.match(err.message, /DRY_RUN/);
  assert.doesNotMatch(err.message, /maybe|nope/);
});

test('TALK_URL must be http or https', () => {
  assert.throws(() => load({ ...base, TALK_API_KEY: 'k', TALK_URL: 'javascript:alert(1)' }), /TALK_URL must be a full https:\/\/ address/);
  assert.equal(load({ ...base, TALK_API_KEY: 'k', TALK_URL: 'https://talk.example/talk/' }).talk.url, 'https://talk.example/talk/');
});

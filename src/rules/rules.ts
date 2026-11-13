// Loads the phrase rules (rules/default.yaml, or the file in RULES_FILE) and compiles the patterns.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const patterns = z.array(z.string().min(1)).default([]);
const words = z.array(z.string().min(1)).default([]);

const RulesFile = z.object({
  version: z.literal(1),
  thresholds: z.object({
    connectedMinSeconds: z.number().int().min(0).default(20),
    voicemailMinWords: z.number().int().min(1).default(8),
    voicemailMaxWordsBeforeGreeting: z.number().int().min(0).default(3),
  }),
  outcomes: z.object({
    carrierIntercept: patterns,
    wrongNumber: patterns,
    voicemailGreeting: patterns,
    mailboxUnavailable: patterns,
    liveMessage: patterns,
  }),
  meetings: z.object({ intent: patterns, agreement: patterns, window: z.number().int().min(10).default(120) }),
  identity: z.object({ companySuffixes: words, notNames: words, stopWords: words }),
});

export interface Rules {
  thresholds: { connectedMinSeconds: number; voicemailMinWords: number; voicemailMaxWordsBeforeGreeting: number };
  outcomes: Record<'carrierIntercept' | 'wrongNumber' | 'voicemailGreeting' | 'mailboxUnavailable' | 'liveMessage', RegExp[]>;
  meetings: { intent: RegExp[]; agreement: RegExp[]; window: number };
  identity: { companySuffix: RegExp; notNames: Set<string>; stopWords: Set<string> };
}

export const DEFAULT_RULES_FILE = fileURLToPath(new URL('../../rules/default.yaml', import.meta.url));

export class RulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RulesError';
  }
}

function compile(list: string[], where: string): RegExp[] {
  return list.map((source, i) => {
    try {
      return new RegExp(source, 'i');
    } catch (err) {
      throw new RulesError(`${where}[${i}] is not a valid pattern: ${(err as Error).message}`);
    }
  });
}

export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function compileRules(source: unknown, file = 'rules'): Rules {
  const parsed = RulesFile.safeParse(source);
  if (!parsed.success) {
    throw new RulesError(`${file}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  }
  const r = parsed.data;
  const outcomes = Object.fromEntries(Object.entries(r.outcomes).map(([k, v]) => [k, compile(v, `outcomes.${k}`)])) as Rules['outcomes'];
  const suffixes = r.identity.companySuffixes.map((s) => escapeRegExp(s.toLowerCase())).join('|');
  return {
    thresholds: r.thresholds,
    outcomes,
    meetings: { intent: compile(r.meetings.intent, 'meetings.intent'), agreement: compile(r.meetings.agreement, 'meetings.agreement'), window: r.meetings.window },
    identity: {
      companySuffix: suffixes ? new RegExp(`\\b(?:${suffixes})\\.?$`, 'i') : /(?!)/,
      notNames: new Set(r.identity.notNames.map((w) => w.toLowerCase())),
      stopWords: new Set(r.identity.stopWords.map((w) => w.toLowerCase())),
    },
  };
}

export function loadRules(file = DEFAULT_RULES_FILE): Rules {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new RulesError(`rules file ${file} can't be read`);
  }
  return compileRules(parseYaml(text), file);
}

/** First pattern that matches, with the matched text (for "why this outcome"). */
export function firstMatch(list: RegExp[], text: string): { pattern: string; text: string; index: number } | null {
  for (const re of list) {
    const m = re.exec(text);
    if (m) return { pattern: re.source, text: m[0], index: m.index };
  }
  return null;
}

// Pulls details out of what the other party said: phone numbers, emails, who they are, and meeting times.
// Rule-based: libphonenumber-js finds and validates numbers, chrono-node reads dates, the rest is regex.
import { findPhoneNumbersInText, type CountryCode } from 'libphonenumber-js';
import * as chrono from 'chrono-node';
import type { Rules } from './rules.ts';
import { zonedTime, zoneOffsetMinutes } from '../time.ts';

/** Who "we" are, so our own name, numbers and email domain are never suggested for the contact. */
export interface Self {
  names: string[];
  companies: string[];
  /** E.164 numbers that belong to us. */
  numbers: string[];
  /** Email domains that belong to us. */
  domains: string[];
}

export type PhoneLabel = 'mobile' | 'work' | 'fax' | 'other';
export interface FoundPhone {
  e164: string;
  label: PhoneLabel;
}

export interface Identity {
  name: { first: string | null; last: string | null } | null;
  company: string | null;
  /** The sentence it came from. */
  evidence: string;
}

export interface Meeting {
  phrase: string;
  start: Date;
  hasTime: boolean;
  agreed: boolean;
}

export function extractPhones(text: string, options: { defaultCountry?: CountryCode; exclude?: string[] } = {}): FoundPhone[] {
  const exclude = new Set(options.exclude ?? []);
  const seen = new Set<string>();
  const found: FoundPhone[] = [];
  for (const m of findPhoneNumbersInText(text, { defaultCountry: options.defaultCountry ?? 'US' })) {
    const e164 = m.number.number;
    if (exclude.has(e164) || seen.has(e164)) continue;
    seen.add(e164);
    // The label word nearest before the number: "office 555..., cell 555..." labels each one correctly.
    const before = text.slice(Math.max(0, m.startsAt - 30), m.startsAt).toLowerCase();
    const word = [...before.matchAll(/\b(cell|mobile|fax|office|work|direct|desk)\b/g)].at(-1)?.[1];
    const label: PhoneLabel = word === 'cell' || word === 'mobile' ? 'mobile' : word === 'fax' ? 'fax' : word ? 'work' : 'other';
    found.push({ e164, label });
  }
  return found;
}

export function extractEmails(text: string, options: { excludeDomains?: string[] } = {}): string[] {
  const exclude = (options.excludeDomains ?? []).map((d) => d.toLowerCase());
  const found = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
  return [...new Set(found.map((e) => e.toLowerCase().replace(/\.$/, '')))].filter((e) => !exclude.some((d) => e.endsWith(`@${d}`)));
}

const TITLES = /^(?:dr|mr|mrs|ms|miss|prof)$/i;
const CONNECTORS = /^(?:of|and|&)$/;

/** Leading capitalised words ("Jane Doe", "Acme Roofing"), and how many words were used. */
function takeCapitalisedRun(words: string[], rules: Rules): { text: string; used: number } {
  const run: string[] = [];
  for (const w of words) {
    const clean = w.replace(/[.,!?;:]+$/, '');
    if (rules.identity.stopWords.has(clean.toLowerCase())) break;
    if (!/^[A-Z&][\w&'-]*$/.test(clean) && !CONNECTORS.test(clean)) break;
    run.push(clean);
    if (/[,!?;:]$/.test(w) || (/\.$/.test(w) && !TITLES.test(clean))) break; // punctuation ends the phrase
  }
  const used = run.length;
  while (run.length && CONNECTORS.test(run.at(-1) ?? '')) run.pop();
  return { text: run.join(' '), used };
}

const INTRO_PATTERNS: Array<{ re: RegExp; companyOnly: boolean }> = [
  { re: /\b(?:this is|my name is|name's|i'm|i am|it's)\s+(.+)/i, companyOnly: false },
  { re: /\b(?:you've reached|you have reached)\s+(?:the\s+)?(?:voicemail of\s+|mailbox of\s+|office of\s+)?(.+)/i, companyOnly: false },
  { re: /\b(?:thanks for calling|thank you for calling)\s+(?:the\s+)?(.+)/i, companyOnly: true },
];
const COMPANY_LINK = /^(?:from|with|at|over at|here at|calling from|of)\s+(.+)/i;
const SENTENCES = /(?<!\b(?:Dr|Mr|Mrs|Ms|Prof|St|Jr|Sr)\.)(?<=[.!?])\s+/;

/**
 * Self-introductions: "this is Jane Doe with Acme Roofing", "you've reached Bob Jones", "thanks for calling Acme".
 * Needs a transcript with capital letters; on all-lowercase text it finds nothing rather than guessing.
 */
export function extractIdentities(text: string, rules: Rules, self: Pick<Self, 'names' | 'companies'>): Identity[] {
  if (!/[A-Z]/.test(text)) return [];
  const selfNames = new Set(self.names.map((n) => n.toLowerCase()));
  const selfCompanies = new Set(self.companies.map((c) => c.toLowerCase()));
  const results: Identity[] = [];
  for (const sentence of text.split(SENTENCES)) {
    let name: Identity['name'] = null;
    let company: string | null = null;
    for (const { re, companyOnly } of INTRO_PATTERNS) {
      const tail = re.exec(sentence)?.[1];
      if (!tail) continue;
      const tailWords = tail.split(/\s+/);
      const { text: head, used } = takeCapitalisedRun(tailWords, rules);
      if (!head) continue;
      const words = head.split(' ').filter((w) => !TITLES.test(w));
      const first = words[0] ?? '';
      if (!words.length || rules.identity.notNames.has(first.toLowerCase())) continue;
      if (companyOnly || rules.identity.companySuffix.test(head) || words.length > 3) {
        company ??= head;
        continue;
      }
      name ??= TITLES.test(head.split(' ')[0] ?? '') ? { first: null, last: words.join(' ') } : { first, last: words.slice(1).join(' ') || null };
      const link = COMPANY_LINK.exec(tailWords.slice(used).join(' '))?.[1];
      if (link) company ??= takeCapitalisedRun(link.split(/\s+/), rules).text || null;
    }
    if (!name && !company) continue;
    const isSelf =
      (name && [name.first, [name.first, name.last].filter(Boolean).join(' ')].some((n) => n && selfNames.has(n.toLowerCase()))) ||
      (company !== null && selfCompanies.has(company.toLowerCase()));
    if (!isSelf) results.push({ name, company, evidence: sentence.trim() });
  }
  return results;
}

/**
 * Dates and times that come with meeting words nearby. `agreed` means agreement words are nearby too.
 * With a time zone, "Tuesday at 3 pm" is 3 pm in that zone; without one, in the server's.
 */
export function extractMeetings(text: string, refDate: Date, rules: Rules, timeZone?: string): Meeting[] {
  const { intent, agreement, window } = rules.meetings;
  const reference = timeZone ? { instant: refDate, timezone: zoneOffsetMinutes(refDate, timeZone) } : refDate;
  return chrono
    .parse(text, reference, { forwardDate: true })
    .filter((r) => r.start.isCertain('hour') || r.start.isCertain('weekday') || r.start.isCertain('day'))
    .flatMap((r) => {
      const context = text.slice(Math.max(0, r.index - window), r.index + r.text.length + window);
      if (!intent.some((re) => re.test(context))) return [];
      const c = r.start;
      const start = timeZone
        ? zonedTime(c.get('year') ?? 0, c.get('month') ?? 1, c.get('day') ?? 1, c.get('hour') ?? 12, c.get('minute') ?? 0, timeZone)
        : c.date();
      return [{ phrase: r.text, start, hasTime: c.isCertain('hour'), agreed: agreement.some((re) => re.test(context)) }];
    });
}

/** Add-to-calendar links the rep can click; no calendar API involved. */
export function calendarLinks(options: { title: string; start: Date; minutes?: number; details?: string; attendee?: string }) {
  const { title, start, minutes = 30, details = '', attendee = '' } = options;
  const end = new Date(start.getTime() + minutes * 60_000);
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const google = new URL('https://calendar.google.com/calendar/render');
  google.search = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${fmt(start)}/${fmt(end)}`, details, add: attendee }).toString();
  const outlook = new URL('https://outlook.office.com/calendar/0/deeplink/compose');
  outlook.search = new URLSearchParams({ subject: title, startdt: start.toISOString(), enddt: end.toISOString(), body: details, to: attendee }).toString();
  return { google: google.toString(), outlook: outlook.toString() };
}

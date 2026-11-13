// Turns spoken digits and spoken email addresses in a transcript into their written form.
// Word tables and regular expressions only.

const DIGIT_WORDS: Record<string, string> = {
  zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};
const MULTIPLIERS: Record<string, number> = { double: 2, triple: 3 };
const TLDS = ['com', 'net', 'org', 'io', 'co', 'us', 'biz', 'info', 'edu', 'gov', 'me', 'app', 'dev', 'ca', 'uk'];

/**
 * "five five five, two oh one, three three four four" → "5552013344".
 * Only runs of 7 or more digits are collapsed, so ordinary words ("one of those") survive.
 */
export function spokenDigitsToNumbers(text: string): string {
  const tokens = text.split(/(\s+|,|-)/); // keep separators so the text can be rebuilt
  const out: string[] = [];
  let run: number[] = [];
  let digits = '';
  let pendingMult = 1;

  const flush = () => {
    if (digits.length >= 7) out.push(digits);
    else for (const i of run) out.push(tokens[i] ?? '');
    run = [];
    digits = '';
    pendingMult = 1;
  };

  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i] ?? '';
    const t = raw.toLowerCase().replace(/[.?!]$/, '');
    if (raw === '' || /^(\s+|,|-)$/.test(raw)) {
      if (run.length) run.push(i);
      else out.push(raw);
      continue;
    }
    const mult = MULTIPLIERS[t];
    if (mult !== undefined) {
      pendingMult = mult;
      run.push(i);
      continue;
    }
    // "o" only counts as zero inside a run, never on its own.
    const d = DIGIT_WORDS[t] ?? (/^\d+$/.test(t) ? t : undefined);
    if (d !== undefined && !(t === 'o' && !run.length)) {
      digits += d.repeat(pendingMult);
      pendingMult = 1;
      run.push(i);
      continue;
    }
    flush();
    out.push(raw);
  }
  flush();
  // Put back a space where a collapsed run now touches a word.
  return out.join('').replace(/(\d{7,})(?=[A-Za-z])/g, '$1 ');
}

/** "jane dot doe at acme roofing dot com" → "jane.doe@acmeroofing.com" */
export function spokenEmailsToAddresses(text: string): string {
  const tld = TLDS.join('|');
  const re = new RegExp(
    String.raw`\b([a-z0-9]+(?:\s+(?:dot|underscore|dash)\s+[a-z0-9]+)*)\s+at\s+` +
      String.raw`((?:[a-z0-9]+\s+){0,3}?[a-z0-9]+(?:\s+dot\s+[a-z0-9]+)*\s+dot\s+(?:${tld}))\b`,
    'gi',
  );
  return text.replace(re, (_match, local: string, domain: string) => {
    const l = local.replace(/\s+dot\s+/gi, '.').replace(/\s+underscore\s+/gi, '_').replace(/\s+dash\s+/gi, '-').replace(/\s+/g, '');
    const d = domain.replace(/\s+dot\s+/gi, '.').replace(/\s+/g, '');
    return `${l}@${d}`.toLowerCase();
  });
}

export function normalizeTranscript(text: string): string {
  return spokenEmailsToAddresses(spokenDigitsToNumbers(text));
}

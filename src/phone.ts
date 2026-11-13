import { parsePhoneNumberFromString, isSupportedCountry, type CountryCode } from 'libphonenumber-js';

export type { CountryCode };

export function toCountry(code: string | null | undefined, fallback: CountryCode = 'US'): CountryCode {
  const upper = (code ?? '').toUpperCase();
  return isSupportedCountry(upper) ? upper : fallback;
}

/** E.164 form of a number, or null when it isn't a valid phone number (extensions, "anonymous"). */
export function toE164(raw: string | null | undefined, country: CountryCode = 'US'): string | null {
  if (!raw) return null;
  const parsed = parsePhoneNumberFromString(raw, country);
  return parsed?.isValid() ? parsed.number : null;
}

/** National format for home-country numbers, international for the rest. */
export function formatPhone(e164: string, country: CountryCode = 'US'): string {
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed) return e164;
  return parsed.country === country ? parsed.formatNational() : parsed.formatInternational();
}

export function nationalNumber(e164: string): string {
  return parsePhoneNumberFromString(e164)?.nationalNumber ?? e164.replace(/^\+/, '');
}

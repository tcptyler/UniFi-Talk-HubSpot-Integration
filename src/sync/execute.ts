// Carries out a planned call in HubSpot: find or create the contact, fill empty contact fields, log the call
// and create the review task. The same code runs for real and in dry runs; only the Writer differs.
import type { CallPlan } from './plan.ts';
import { API_VERSION, CONTACT_ID, OWNER_ID } from '../hubspot/calls.ts';
import type { HubSpotClient } from '../hubspot/client.ts';
import type { HubSpotContext } from '../hubspot/lookup.ts';

/** What gets filled in on contacts from what was said on calls (an admin setting). */
export const AUTO_FILL_MODES = ['new-and-existing', 'new-only', 'existing-only', 'suggest-only'] as const;
export type AutoFill = (typeof AUTO_FILL_MODES)[number];

export interface ExecuteOptions {
  autoFill: AutoFill;
  /** Spam guard: an unknown inbound caller becomes a contact only after this much talk time, or a voicemail. */
  minTalkSecondsForNewContact: number;
  /** Owner when neither the Talk user nor the contact has one. */
  defaultOwnerId?: string;
}

/** Sends writes: to HubSpot for real, or to a recorder in dry runs. */
export interface Writer {
  create(path: string, body: unknown): Promise<string>;
  update(path: string, properties: Record<string, string>): Promise<void>;
}

export interface ExecuteResult {
  uuid: string;
  result: 'logged' | 'already logged' | 'skipped';
  reason: string;
  contactId: string | null;
  contactCreated: boolean;
  /** Contact fields filled in from the call. */
  filled: string[];
  callId: string | null;
  taskId: string | null;
  /** The call was logged but its review task could not be created. */
  taskError?: string;
}

const LABELS: Record<string, string> = { firstname: 'first name', lastname: 'last name', company: 'company', email: 'email', mobilephone: 'mobile number' };
const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/**
 * Contact fields from what the other party said. Only unambiguous details count: one introduction, one email,
 * one mobile number. On a live-message call the person who introduced themselves is usually a receptionist,
 * so nothing is filled from it.
 */
export function contactFields(plan: CallPlan): Record<string, string> {
  const d = plan.details;
  if (!d || plan.outcome === 'Left live message') return {};
  const out: Record<string, string> = {};
  const [only] = d.identities.length === 1 ? d.identities : [];
  if (only?.name?.first) out.firstname = only.name.first;
  if (only?.name?.last) out.lastname = only.name.last;
  if (only?.company) out.company = only.company;
  if (d.emails.length === 1) out.email = d.emails[0]!;
  const mobiles = d.phones.filter((p) => p.label === 'mobile' && p.e164 !== plan.externalNumber);
  if (mobiles.length === 1) out.mobilephone = mobiles[0]!.e164;
  return out;
}

/** Puts the contact and owner ids into a planned request body, or drops them when there are none. */
export function fillIds(body: unknown, contactId: string | null, ownerId: string | null): unknown {
  const b = structuredClone(body) as { properties?: Record<string, string>; associations?: Array<{ to: { id: string } }> };
  if (b.properties && b.properties.hubspot_owner_id === OWNER_ID) {
    if (ownerId) b.properties.hubspot_owner_id = ownerId;
    else delete b.properties.hubspot_owner_id;
  }
  if (b.associations) {
    b.associations = contactId
      ? b.associations.map((a) => (a.to.id === CONTACT_ID ? { ...a, to: { id: contactId } } : a))
      : b.associations.filter((a) => a.to.id !== CONTACT_ID);
  }
  return b;
}

export async function executePlan(client: HubSpotClient, writer: Writer, hs: HubSpotContext, plan: CallPlan, options: ExecuteOptions): Promise<ExecuteResult> {
  const result: ExecuteResult = { uuid: plan.uuid, result: 'skipped', reason: plan.reason, contactId: null, contactCreated: false, filled: [], callId: null, taskId: null };
  if (plan.action !== 'log') return result;
  const callRequest = plan.requests.find((r) => r.path.endsWith('/calls'));
  if (!callRequest) return { ...result, reason: 'nothing to log' };

  // Never log the same Talk call twice.
  const existing = await client.findCallByTalkId(plan.uuid);
  if (existing) return { ...result, result: 'already logged', reason: 'already in HubSpot', callId: existing };

  const talkOwner = plan.talkUser?.email ? (hs.ownersByEmail.get(plan.talkUser.email.toLowerCase())?.id ?? null) : null;
  const fields = contactFields(plan);
  let contactId: string | null = null;
  let contactOwner: string | null = null;
  let filled: string[] = [];
  let created = false;

  if (plan.externalNumber) {
    const found = await client.findContactsByPhone(plan.externalNumber);
    const first = found.results[0];
    if (first) {
      contactId = first.id;
      const owner = first.properties?.hubspot_owner_id;
      contactOwner = typeof owner === 'string' && owner ? owner : null;
      // Existing contacts: fill empty fields only, never overwrite, and only when the number matches one contact.
      if (found.results.length === 1 && (options.autoFill === 'new-and-existing' || options.autoFill === 'existing-only')) {
        const patch = Object.fromEntries(Object.entries(fields).filter(([k]) => isEmpty(first.properties?.[k])));
        if (Object.keys(patch).length) {
          await writer.update(`/crm/objects/${API_VERSION}/contacts/${contactId}`, patch);
          filled = Object.keys(patch);
        }
      }
    } else {
      // Spam guard for unknown inbound callers. Numbers a rep dialled always become contacts.
      if (plan.direction === 'inbound' && !plan.voicemailLeft && plan.talkSeconds < options.minTalkSecondsForNewContact) {
        return { ...result, reason: `unknown caller, under ${options.minTalkSecondsForNewContact} s and no voicemail (spam guard)` };
      }
      const fill = options.autoFill === 'new-and-existing' || options.autoFill === 'new-only' ? fields : {};
      const owner = talkOwner ?? options.defaultOwnerId ?? null;
      contactId = await writer.create(`/crm/objects/${API_VERSION}/contacts`, {
        properties: { phone: plan.externalNumber, ...fill, ...(owner ? { hubspot_owner_id: owner } : {}) },
        associations: [],
      });
      created = true;
      filled = Object.keys(fill);
    }
  }

  const ownerId = talkOwner ?? contactOwner ?? options.defaultOwnerId ?? null;
  const callBody = fillIds(callRequest.body, contactId, ownerId) as { properties: Record<string, string> };
  if (filled.length) {
    const which = created ? 'the new contact' : 'the contact';
    const note = `<p>Filled in on ${which} from what they said on this call: ${filled.map((f) => LABELS[f] ?? f).join(', ')}.</p>`;
    callBody.properties.hs_call_body = (callBody.properties.hs_call_body ?? '').replace('</p>', `</p>\n${note}`);
  }
  const callId = await writer.create(callRequest.path, callBody);

  let taskId: string | null = null;
  let taskError: string | undefined;
  const taskRequest = plan.requests.find((r) => r.path.endsWith('/tasks'));
  if (taskRequest) {
    try {
      taskId = await writer.create(taskRequest.path, fillIds(taskRequest.body, contactId, ownerId));
    } catch (err) {
      taskError = (err as Error).message; // the call is logged; don't fail it over the task
    }
  }
  return { ...result, result: 'logged', reason: plan.reason, contactId, contactCreated: created, filled, callId, taskId, ...(taskError ? { taskError } : {}) };
}

/** Writes to HubSpot. */
export function hubspotWriter(client: HubSpotClient): Writer {
  return { create: (path, body) => client.create(path, body), update: (path, properties) => client.update(path, properties) };
}

/** Records writes instead of sending them, for dry runs. */
export function recordingWriter(): Writer & { writes: Array<{ method: 'POST' | 'PATCH'; path: string; body: unknown }> } {
  const writes: Array<{ method: 'POST' | 'PATCH'; path: string; body: unknown }> = [];
  return {
    writes,
    async create(path, body) {
      writes.push({ method: 'POST', path, body });
      return `dry-run-${writes.length}`;
    },
    async update(path, properties) {
      writes.push({ method: 'PATCH', path, body: { properties } });
    },
  };
}

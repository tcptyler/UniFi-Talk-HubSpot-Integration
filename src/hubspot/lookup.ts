// Read-only HubSpot lookups for a planned call: which contact, which owner, and whether it is already logged.
import type { CallPlan } from '../sync/plan.ts';
import type { AccountDetails, CallOutcome, HubSpotClient, Owner } from './client.ts';

export interface HubSpotContext {
  account: AccountDetails;
  ownersByEmail: Map<string, Owner>;
  outcomes: CallOutcome[];
  /** A custom outcome whose label says "meeting booked" (HubSpot Pro and up), if the portal has one. */
  meetingBookedOutcome: CallOutcome | null;
}

export async function loadHubSpotContext(client: HubSpotClient): Promise<HubSpotContext> {
  const account = await client.accountDetails();
  const owners = await client.owners();
  const outcomes = await client.callOutcomes();
  const ownersByEmail = new Map(owners.filter((o) => o.email && !o.archived).map((o) => [o.email!.toLowerCase(), o]));
  const meetingBookedOutcome = outcomes.find((o) => /meeting\s*(booked|scheduled|set)/i.test(o.label)) ?? null;
  return { account, ownersByEmail, outcomes, meetingBookedOutcome };
}

export interface HubSpotMatch {
  /** Contacts with this phone number (more than one means duplicates in HubSpot). */
  contactIds: string[];
  /** The owner the call and task would get, and why. */
  ownerId: string | null;
  ownerSource: 'talk user' | 'contact owner' | null;
  /** The call is already in HubSpot (logged earlier by this integration). */
  existingCallId: string | null;
}

/** Looks up one planned call. `cache` keeps one search per phone number per run. */
export async function matchPlan(client: HubSpotClient, hs: HubSpotContext, plan: CallPlan, cache: Map<string, Awaited<ReturnType<HubSpotClient['findContactsByPhone']>>>): Promise<HubSpotMatch> {
  let contacts: Awaited<ReturnType<HubSpotClient['findContactsByPhone']>> = { results: [] };
  if (plan.externalNumber) {
    contacts = cache.get(plan.externalNumber) ?? (await client.findContactsByPhone(plan.externalNumber));
    cache.set(plan.externalNumber, contacts);
  }
  const contactIds = contacts.results.map((r) => r.id);
  const talkOwner = plan.talkUser?.email ? hs.ownersByEmail.get(plan.talkUser.email.toLowerCase()) : undefined;
  const contactOwner = contacts.results.map((r) => r.properties?.hubspot_owner_id).find((v): v is string => typeof v === 'string' && v !== '');
  const existingCallId = await client.findCallByTalkId(plan.uuid);
  return {
    contactIds,
    ownerId: talkOwner?.id ?? contactOwner ?? null,
    ownerSource: talkOwner ? 'talk user' : contactOwner ? 'contact owner' : null,
    existingCallId,
  };
}

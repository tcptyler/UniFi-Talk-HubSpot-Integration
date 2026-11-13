// Shapes of the UniFi Talk web UI API responses the integration relies on (observed on Talk 5.3 to 5.4.8).
// Talk has no official API, so every response is validated: if Ubiquiti changes a shape, the integration
// stops and reports it instead of writing bad data into the CRM. Unknown extra fields are kept.
import { z } from 'zod';

const nullableString = z.string().nullable().optional();

export const TalkInfo = z.looseObject({
  version: z.string(),
  update_channel: nullableString,
  host_device_model: nullableString,
  default_country: nullableString,
});
export type TalkInfo = z.infer<typeof TalkInfo>;

export const TalkUserInfo = z.looseObject({
  role: nullableString,
  user_has_talk_view_permissions: z.boolean().optional(),
  user_has_talk_manage_permissions: z.boolean().optional(),
});

export const CallEvent = z.looseObject({
  time: z.string(),
  event: z.string(),
  event_data: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type CallEvent = z.infer<typeof CallEvent>;

export const CallRecord = z.looseObject({
  uuid: z.string(),
  time: z.string(),
  from: nullableString,
  to: nullableString,
  direction: z.enum(['in', 'out']).nullable().optional(), // null = internal call
  status: z.unknown().optional(), // varies by Talk version; never trusted for outcomes
  duration: z.number().nullable().optional(),
  answered_by: nullableString,
  answered_by_user_uuid: nullableString,
  from_id: nullableString,
  from_did: nullableString,
  from_caller_name: nullableString,
  from_contact_id: z.number().nullable().optional(),
  to_contact_id: z.number().nullable().optional(),
  recording: z.boolean().nullable().optional(),
  recording_filename: nullableString,
  is_intercom_call: z.boolean().nullable().optional(),
  vm_data: z.record(z.string(), z.unknown()).nullable().optional(),
  call_events: z.array(CallEvent).default([]),
});
export type CallRecord = z.infer<typeof CallRecord>;

export const CallLogPage = z.looseObject({
  records: z.array(CallRecord),
  total_count: z.union([z.string(), z.number()]).transform((v) => Number(v)),
});
export type CallLogPage = z.infer<typeof CallLogPage>;

// Seconds from the start of the call. Talk 5.3 sent these as strings, 5.4 as numbers.
const seconds = z.union([z.number(), z.string()]).nullable().optional();

export const TranscriptLine = z.looseObject({
  speaker: z.string(),
  line: z.string(),
  line_start_time: seconds,
  line_end_time: seconds,
});
export type TranscriptLine = z.infer<typeof TranscriptLine>;

export const Transcript = z.looseObject({
  status: z.string(),
  context: z.looseObject({ call_uuid: nullableString, call_direction: nullableString }).nullable().optional(),
  analytics: z.looseObject({
    summary: nullableString,
    lines: z.array(TranscriptLine).default([]),
  }).nullable().optional(),
});
export type Transcript = z.infer<typeof Transcript>;

export const TalkUser = z.looseObject({
  unique_id: z.string(),
  first_name: nullableString,
  last_name: nullableString,
  full_name: nullableString,
  email: nullableString,
  user_email: nullableString,
  ext: nullableString,
  did: nullableString,
  did_list: z.array(z.unknown()).nullable().optional(),
});
export type TalkUser = z.infer<typeof TalkUser>;

export const TalkNumber = z.looseObject({
  did: z.string(),
  sms_capable: z.boolean().nullable().optional(),
  sms_enabled: z.boolean().nullable().optional(),
});
export type TalkNumber = z.infer<typeof TalkNumber>;

export const SmsConversation = z.looseObject({
  id: z.union([z.string(), z.number()]),
  participants: z.array(z.unknown()).nullable().optional(),
  last_message_at: nullableString,
  message_count: z.number().nullable().optional(),
});
export type SmsConversation = z.infer<typeof SmsConversation>;

export const SmsMessage = z.looseObject({
  sid: z.string(),
  status: nullableString,
  created_at: z.string(),
  from_number: nullableString,
  to_number: nullableString,
  msg_data: z.looseObject({
    direction: z.string(), // 'in' | 'out'
    text: nullableString,
    fromNumber: nullableString,
    toNumber: nullableString,
  }),
});
export type SmsMessage = z.infer<typeof SmsMessage>;

export const TalkContact = z.looseObject({
  id: z.number(),
  uuid: z.string(),
  first_name: nullableString,
  last_name: nullableString,
  email: nullableString,
  organization: nullableString,
  title: nullableString,
  updated_at: nullableString,
  phone_numbers: z.array(z.looseObject({ did: z.string(), label: nullableString })).default([]),
});
export type TalkContact = z.infer<typeof TalkContact>;

# UniFi Talk to HubSpot

A free, self-hosted bridge that logs UniFi Talk calls and texts in HubSpot and keeps contacts in sync.

- **No AI.** Outcomes and details come from rules you can read and edit. No LLM ever sees your calls.
- **Self-hosted.** Runs on your own machine or server. Nothing is hosted in the cloud, and there is no telemetry.
- **Free.** Bring your own UniFi console and HubSpot account.

> **Status: early development, not ready to use.** The console connection, setup checks and a dry-run preview of call logging work. Writing to HubSpot is being built next. Watch the repository for the first release.

> **Unofficial.** UniFi Talk has no public API. This project uses the same private endpoints as the Talk web app, which Ubiquiti can change in any update. Every response is validated, and the integration stops and reports a problem rather than writing bad data into your CRM.

## What it will do

1. **Log calls:** every external call becomes a HubSpot call with direction, status, duration, numbers, owner, contact and company. Internal calls are skipped.
2. **Pick the outcome:** connected, busy, no answer, left voicemail, left live message, meeting booked or wrong number, from Talk's call events and transcript.
3. **Ask the rep to confirm:** a HubSpot task to review the logged call.
4. **Attach the details:** the transcript, Talk's own summary (can be turned off), and a link to the recording.
5. **Log texts** word for word, marked `***INBOUND***` or `***OUTBOUND***`.
6. **Sync contacts** between HubSpot and Talk.
7. **Fill in missing details** (names, companies, phone numbers and emails mentioned on a call), as suggestions or automatically.
8. **Meetings:** when a call books a meeting, create the meeting or a reminder task.

Build order: call logging (dry run first), transcripts and outcomes, texts, contact sync, then details and meetings.

## How it works

- Reads the Talk call log from your console over HTTPS, every 60 seconds by default. No inbound ports are needed.
- Pins your console's self-signed certificate by its SHA-256 fingerprint instead of turning certificate checks off.
- Writes to HubSpot with a Service Key. There is no public app and no OAuth server to run.
- Dry run is the default: it shows exactly what it would write to HubSpot until you switch writing on.

## Requirements

- A UniFi console running UniFi Talk (developed against Talk 5.4).
- Node.js 22.18 or newer. A Docker image will follow.
- A way to sign in to the console (below).
- For writing to HubSpot: a HubSpot Service Key with these scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.companies.read`, `crm.objects.companies.write`, `crm.objects.owners.read`.

## Signing in to the console

Talk only answers a signed-in console session or a console API key.

| Method | Settings | Notes |
|---|---|---|
| Console API key | `TALK_API_KEY` | Created on the console (in UniFi Network under Settings > Integrations; the location varies by version). Whether Talk accepts these keys is still being tested. |
| Local account | `TALK_USERNAME`, `TALK_PASSWORD` | A dedicated local console account with access to Talk. Consoles in a UniFi Fabric can't create local accounts. |
| Session token | `TALK_SESSION_TOKEN` | The `TOKEN` cookie from a browser session. For testing only: it expires. |

The integration signs in once and reuses the session. If the console refuses a password, it waits 15 minutes before trying again so the account isn't locked.

## Try it

```bash
git clone https://github.com/tcptyler/UniFi-Talk-HubSpot-Integration.git
cd UniFi-Talk-HubSpot-Integration
npm ci
cp .env.example .env
```

Get your console's certificate fingerprint, check it matches what your browser shows for the console, and put it in `.env` as `TALK_CERT_SHA256`:

```bash
npm start -- fingerprint 192.168.1.1
```

Add a sign-in method to `.env`, then check the connection:

```bash
npm start -- check
```

See what would be logged in HubSpot for the last day of calls, without writing anything:

```bash
npm start -- preview --hours 24
```

The terminal shows each call's outcome and the rule that picked it, with no phone numbers or names. The exact HubSpot requests, including notes and transcripts, go to a private file in `DATA_DIR`.

## How outcomes are picked

No AI is involved. The rules live in [`rules/default.yaml`](rules/default.yaml) as plain phrase lists you can read and change (copy the file and set `RULES_FILE`).

1. **Call events first:** busy (the other end refused the call), no answer, and voicemails left by callers come straight from Talk.
2. **Then the transcript, side by side:** Talk labels speakers `speaker_0` and `speaker_1` without saying which is you. The integration works it out from introductions ("this is Alex from Northwind"), voicemail and receptionist phrases, and finally who spoke first.
3. **Phrase rules:** wrong number, a recorded "not in service" message, a voicemail greeting followed by your message, someone taking a message, and a meeting with a date, a time and agreement.
4. **Details** (names, companies, phone numbers, emails) are only taken from the other party's words, so your own callback number never lands on the contact.

Every logged call says which rule decided it, and a review task asks the rep to confirm.

## Configuration

Settings come from environment variables (or `.env`), then an optional `config.yaml`, then defaults. Any secret can be read from a file instead by setting `NAME_FILE`, which suits Docker secrets. See [`.env.example`](.env.example).

| Variable | Default | Meaning |
|---|---|---|
| `TALK_HOST` | (required) | Console address |
| `TALK_PORT` | `443` | Console HTTPS port |
| `TALK_CERT_SHA256` | (required) | Pinned certificate fingerprint |
| `TALK_API_KEY` / `TALK_USERNAME` + `TALK_PASSWORD` / `TALK_SESSION_TOKEN` | | Sign-in, see above |
| `TALK_AUTH` | inferred | Force a sign-in method: `apiKey`, `localAccount` or `sessionToken` |
| `TALK_POLL_SECONDS` | `60` | How often to read the call log (minimum 15) |
| `TALK_URL` | `https://<TALK_HOST>/talk/` | Talk's web page, linked from HubSpot for playing recordings |
| `HUBSPOT_TOKEN` | | HubSpot Service Key |
| `HUBSPOT_MEETING_BOOKED_OUTCOME_ID` | | A custom "Meeting booked" call outcome (HubSpot Pro and up). Without it, those calls are marked Connected |
| `COMPANY_NAMES` | | Your company names, comma separated, so your own introductions are recognised |
| `TIME_ZONE` | server's | Your time zone, for example `America/Chicago`, for reading "Tuesday at 3 pm" |
| `DEFAULT_COUNTRY` | console's | Country for numbers said without a country code |
| `RULES_FILE` | `rules/default.yaml` | Your own copy of the outcome rules |
| `DRY_RUN` | `true` | Only show what would be written |
| `TALK_SUMMARY` | `true` | Include Talk's call summary in the HubSpot notes |
| `DATA_DIR` | `./data` | Local database folder |
| `LOG_LEVEL` | `info` | Log detail |

## Privacy

- Everything runs on your hardware and only talks to your console and HubSpot.
- Logs and command output never include credentials. Error reports about unexpected Talk responses name fields, not values.

## Development

```bash
npm test
npm run check
```

Tests run against a simulated console with made-up data. Please never commit real call data, recordings, transcripts or credentials.

## License

[Apache License 2.0](LICENSE) with the [Commons Clause](https://commonsclause.com/). In short: you can use, change and share it for free, as long as you keep the copyright and license notices and mark files you changed. You can't sell it, or a product or service whose value comes mainly from it. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Trademarks

UniFi and UniFi Talk are trademarks of Ubiquiti Inc. HubSpot is a trademark of HubSpot, Inc. This project is not affiliated with or endorsed by either company.

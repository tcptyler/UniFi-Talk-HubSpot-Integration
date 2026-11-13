# UniFi Talk to HubSpot

A free, self-hosted bridge that logs UniFi Talk calls and texts in HubSpot and keeps contacts in sync.

- **No AI.** Outcomes and details come from rules you can read and edit. No LLM ever sees your calls.
- **Self-hosted.** Runs on your own machine or server. Nothing is hosted in the cloud, and there is no telemetry.
- **Free.** Bring your own UniFi console and HubSpot account.

> **Status: early development, not ready to use.** The console connection and setup checks work. HubSpot logging is being built next. Watch the repository for the first release.

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
| `HUBSPOT_TOKEN` | | HubSpot Service Key |
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

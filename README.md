# Church Intercom

A low-latency audio intercom for church production teams — camera operators,
sound, lighting, and floor managers talking to each other during a service.

Runs as a self-contained appliance on one Linux machine on the church LAN.
**No internet connection is needed at run time.** Participants join from any
phone, tablet, or laptop with a browser; no app to install.

> **Deploying it?** Go straight to **[DEPLOY.md](DEPLOY.md)**. This file covers
> what the system is and how it works internally.

---

## What it does

- **Multiple rooms.** Independent audio channels so the camera team and the
  sound desk are not talking over each other.
- **Hardware feeds.** Each physical input on a USB audio interface is published
  as its own **independent mono feed**. Users subscribe to either, both, or
  neither, with per-feed volume. Typically one is the program mix and the other
  is a talkback line.
- **Talk to the building.** An admin can route their microphone out of the
  server's physical audio output — into the PA, a foldback wedge, or headphones
  at the desk.
- **Push-to-talk**, including physical headset buttons.
- **Admin controls** — kick a participant, choose input/output devices.

---

## How it works

```
 phones / tablets / laptops                    server appliance
 ┌──────────────────────┐                ┌──────────────────────────────┐
 │  browser             │   WebRTC       │  mediasoup SFU               │
 │  mediasoup-client    │◄──── Opus ────►│  (one router, all rooms)     │
 │  (bundled, no CDN)   │   DTLS/SRTP    │                              │
 └──────────────────────┘                │      ▲               │       │
            ▲                            │      │ RTP           │ RTP   │
            │ HTTPS + Socket.IO          │      │               ▼       │
            │ (session cookie)           │  ┌────────┐     ┌──────────┐ │
            └────────────────────────────┤  │ ffmpeg │     │  ffmpeg  │ │
                                         │  │capture │     │ playback │ │
                                         │  └────────┘     └──────────┘ │
                                         │      ▲               │       │
                                         └──────┼───────────────┼───────┘
                                                │ ALSA          ▼
                                          USB audio interface (hw:1,0)
                                          ch 1 → feed 1   ch 2 → feed 2
```

Audio is a **selective forwarding unit**, not a mesh: each participant sends one
stream up and receives one per speaker, so CPU and bandwidth scale linearly
rather than quadratically.

**Capture is a single ffmpeg process, by necessity.** ALSA allows only one
process to open a hardware device, so two inputs cannot mean two processes. One
ffmpeg reads all channels and splits them with the `pan` filter into one Opus
RTP stream per channel, each feeding a persistent mediasoup producer. The
producers outlive the ffmpeg process, so a capture crash — an unplugged
interface, a USB re-enumeration — reconnects without disturbing listeners.

### Components

| Layer | Choice | Why |
|---|---|---|
| Media | mediasoup | SFU; audio-only Opus at 48 kHz |
| Signalling | Socket.IO | Shares the Express session, so auth is one mechanism |
| Audio I/O | ffmpeg + ALSA | No native Node audio addons to compile or break |
| Store | PostgreSQL | User accounts and sessions only |
| Client | Vanilla JS | No build step for app code, no framework to age |

---

## Repository layout

| Path | Purpose |
|---|---|
| `server.js` | HTTP/S, routes, Socket.IO handlers, lifecycle |
| `config.js` | Env parsing and validation; refuses to boot on bad config |
| `audio.js` | `AudioCapture` and `AudioPlayback` — ffmpeg supervision |
| `auth.js` | Passwordless sign-in, session middleware, first-admin bootstrap |
| `db.js` | Pool, startup retry, health probe |
| `healthcheck.js` | Container healthcheck; exits non-zero when degraded |
| `public/index.html` | The whole client |
| `public/vendor/` | mediasoup-client bundle, built at image build time |
| `deploy/` | systemd unit |

---

## Local development

Requires Node 20+ and ffmpeg. Docker is not needed to develop.

```bash
npm install
npm run build:vendor     # required once — see below
npm run dev              # NODE_ENV=development BYPASS_AUTH=true
```

`npm run dev` sets `BYPASS_AUTH=true`, which needs no database and accepts any
username at all — including one no account exists for. With no `is_admin`
column to consult it treats every account as admin-capable, so ticking "Sign in
as administrator" works for anyone. `config.js` **refuses to start** with that
flag under `NODE_ENV=production`.

**This is also how the appliance runs.** See [Security](#security).

Then open <http://localhost:3000>. Microphone access works on `localhost`
without HTTPS; on any other address it does not.

To develop against a real database instead, run Postgres, apply
`database.sql`, and copy `.env.example` to `.env`.

### `npm run build:vendor` is not optional

`mediasoup-client` publishes CommonJS with bare specifiers, which a browser
cannot import. Without this step the page cannot load the audio engine at all.
The Dockerfile runs it during the image build; locally you run it once after
`npm install`.

Bundling it also means **the client never contacts a CDN** — the appliance works
with the internet unplugged.

---

## Configuration

`.env` is the only configuration file. Full reference with commentary is in
[`.env.example`](.env.example); the essentials:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `HTTPS` | `false` | Effectively required — browsers block mic access otherwise |
| `SSL_KEY_PATH` / `SSL_CERT_PATH` | — | Required when `HTTPS=true`; checked at boot |
| `ANNOUNCED_IP` | auto-detected | The LAN address given to clients. Set only if multi-homed |
| `RTP_PORT_MIN` / `RTP_PORT_MAX` | `40000` / `40199` | Must be open, UDP |
| `ROOMS` | eight defaults | Comma-separated; the client reads this from the server |
| `SESSION_SECRET` | — | Required; boot fails on the placeholder value |
| `BOOTSTRAP_ADMIN_USERNAME` | `admin` | Creates the first admin, first boot only |
| `AUDIO_CAPTURE_ENABLED` | `false` | |
| `AUDIO_CAPTURE_DEVICE` | `hw:1,0` | ALSA device — find it with `arecord -l` |
| `AUDIO_CAPTURE_CHANNELS` | `2` | One independent mono feed per channel |
| `AUDIO_CHANNEL_<n>_NAME` | `Input <n>` | Shown to users |
| `AUDIO_PLAYBACK_ENABLED` | `false` | Allows "talk to the building" |
| `DEBUG_AUDIO` | `false` | Verbose ffmpeg; noisy, and writes cost flash endurance |

Invalid configuration is a **startup failure, not a warning** — a missing
certificate or placeholder secret stops the boot with an explicit message,
rather than silently running something insecure.

---

## HTTP API

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/login` | — | Rate limited; regenerates the session id |
| `POST /api/logout` | — | |
| `GET /api/user` | session | Current user |
| `GET /api/rooms` | session | Room list — the client's single source |
| `POST /api/register` | **admin** | Create an account |
| `GET /api/health` | — | Subsystem status; drives the container healthcheck |

There is no self-registration. An intercom is not a public service, so accounts
are created by an admin.

`/api/health` returns `200` only when the database and mediasoup worker are both
up, and includes per-feed `bytesReceived` counters — the only reliable evidence
that audio is genuinely arriving, since a running ffmpeg proves nothing.

## Socket.IO events

The room is fixed from the handshake and **never read from later messages**.
Every handler uses the server-side value, which is what prevents a client from
producing into, or consuming from, a room it never joined.

**Client → server:** `getRtpCapabilities`, `createTransport`,
`connectTransport`, `produce`, `consume`, `resumeConsumer`, `closeConsumer`,
`getProducers`, `getFeeds`, `kick` *(admin)*, `setPlayback` *(admin)*

**Server → client:** `peers`, `peer-joined`, `peer-left`, `new-producer`,
`producer-closed`, `feeds`, `playback-state`, `kicked`, `error`

---

## Security

**There is no authentication, by design.** The appliance runs with
`BYPASS_AUTH=true` and no database: sign-in takes any username, and ticking
"Sign in as administrator" grants admin to whoever ticks it. The single control
that matters is the **network** — one machine on the church LAN, no route in
from outside, nothing published to the internet. Everything below is what
remains rather than what protects you.

Read that as: anyone who can reach the box can join any room, hear everything,
kick people out, and take over the building's speakers. That is an accepted
trade for volunteers who need to be on air in seconds, not a gap to be closed
with a password. **Do not expose this to the internet, to guest Wi-Fi, or to
any network you do not control.** If that ever changes, the auth model has to
change with it.

The account roster below only applies to an install that is wired to a
database, which the appliance is not:

- Sign-in is passwordless: the username is the credential, and it must match an
  active account. Revoke someone with `is_active = FALSE`.
- Admin is `is_admin` on the account AND the "Sign in as administrator"
  checkbox — the column is the capability, the checkbox the intent. Ticking the
  box without the column grants nothing. Because intent can only subtract, an
  admin can deliberately take an ordinary session, which is useful when a
  volunteer borrows the tablet.
- `is_admin` is re-read from the database on every admin request, so revoking
  it bites immediately rather than when the 30-day session expires.

Still true on every install:
- Session cookies `httpOnly`, `sameSite=lax`, and `secure` whenever HTTPS is on
- Session id regenerated on login (fixation)
- Login rate limited per address
- Room membership enforced server-side on every media operation
- Only the vendored client bundle is served — not `node_modules`
- Parameterised SQL throughout
- Same-origin Socket.IO

**Not included:** audit logging, account lockout, 2FA, or per-room
authorisation. This is a trusted-LAN appliance, and the threat model is
accidental misuse rather than a determined attacker on the network.

If you are adopting this repository, read **§12 of [DEPLOY.md](DEPLOY.md)** — a
TLS private key and a `.env` are present in the git history and must be rotated.

---

## Operating it

```bash
docker compose logs -f app                   # what is happening
curl -sk https://localhost:3443/api/health   # full subsystem status
docker compose exec app arecord -l           # what ALSA sees from inside
sudo systemctl restart church-intercom       # bounce the stack
```

The stack restarts itself on failure, recovers capture automatically with
backoff, retries a slow database rather than crash-looping, caps its own logs so
it cannot fill the disk, and takes a nightly `pg_dump`. Troubleshooting table is
in §11 of [DEPLOY.md](DEPLOY.md).

---

## Resilience behaviour

Worth knowing, because these are the things that decide whether a service runs:

- **A dropped connection does not eject you.** Losing Wi-Fi puts the client into
  *Reconnecting…*; Socket.IO retries forever, and the media session (transports,
  producers, consumers, feed subscriptions) is rebuilt automatically when it
  returns. The microphone stream is deliberately kept alive across the gap so
  the browser does not re-prompt for permission every time.
- **Joining cannot hang forever.** A 30-second watchdog covers the whole setup —
  an unanswered permission prompt, a stalled WebRTC handler, a transport that
  never negotiates. On expiry the user gets a plain-English message and the room
  picker back, rather than a frozen screen and a page reload.
- **Screen wake lock** is held while in a room, so a phone on a camera does not
  sleep and suspend its audio. It cannot survive the user switching apps — no
  browser API can.
- **Speaking indicators** are measured server-side by mediasoup, so *"Heard by
  room"* means the audio genuinely reached the server, not merely that the
  microphone is open locally.

## Testing

```bash
npm run test:signalling   # against a running stack on :38080
```

Covers login, session cookies, room-scoping enforcement, and the full
reconnection contract (forced transport close → automatic reconnect → new
socket id → room state re-delivered).

Audio capture can be exercised without hardware — see §8 of
[DEPLOY.md](DEPLOY.md) for the two-tone `lavfi` setup.

## Known limitations

- **One mediasoup worker.** Fine for a few dozen participants on one machine;
  beyond that you would want a worker per CPU core and a router per room.
- **One audio interface.** Capture and playback share a device.
- **One person at a time** on the server output — ALSA will not mix two writers
  to a hardware device.
- **Feed level meters are client-side.** mediasoup's audio level observer reads
  the `ssrc-audio-level` RTP header extension, which browsers send and ffmpeg
  does not, so hardware feeds are metered from the decoded audio in the browser
  instead. `bytesReceived` in `/api/health` is the server-side equivalent.
- **iOS suspends backgrounded tabs.** If someone switches apps, their audio
  stops. Keep the app foregrounded; a dedicated device per position is more
  reliable than a personal phone.

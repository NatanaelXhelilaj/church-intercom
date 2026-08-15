# Deploying Church Intercom

A single Linux machine on the church LAN, running the stack in Docker. No
internet connection is required at run time.

---

## 1. Hardware

**Audio interface.** Use a **USB class-compliant (UAC2)** interface — Behringer
UMC202HD, Focusrite Scarlett 2i2, MOTU M2, or similar. These need no drivers on
Linux; ALSA sees them natively, which is exactly what you want on a box that has
to boot unattended.

> **Waves SoundGrid will not work.** The SoundGrid driver ships only for ASIO
> (Windows) and Core Audio (macOS). There is no Linux driver and no public SDK
> for host connectivity. If the mixer has a class-compliant USB audio output,
> use that; otherwise use a separate USB interface fed from the desk.

Each hardware input becomes an **independent mono feed**. Users subscribe to
either or both. Feed 1 and feed 2 are entirely separate streams.

**The USB stick.** Flash has limited write endurance and corrupts on sudden
power loss. This deployment mitigates that, but if you can add even a cheap
internal SSD for the database volume, do — it is the single biggest reliability
improvement available. See §9.

---

## 2. Host preparation

Debian 12 or Ubuntu Server, minimal install.

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker
```

Reduce writes to the stick. Add `noatime` to the root filesystem in
`/etc/fstab`, so reading a file no longer causes a write:

```
UUID=xxxx  /  ext4  defaults,noatime,errors=remount-ro  0  1
```

Cap the systemd journal so logs cannot fill the stick — in
`/etc/systemd/journald.conf`:

```
[Journal]
Storage=persistent
SystemMaxUse=200M
```

Then `sudo systemctl restart systemd-journald`.

---

## 3. Identify the sound card

Plug the interface in and ask ALSA what it found:

```bash
arecord -l
```

Output looks like:

```
card 1: USB [Scarlett 2i2 USB], device 0: USB Audio [USB Audio]
```

That is `hw:1,0` — card 1, device 0. Put it in `AUDIO_CAPTURE_DEVICE`.

Prefer an explicit `hw:` device over `default`; `default` routes through dmix
and adds latency you do not want on an intercom.

Confirm the audio group id (29 on Debian and Ubuntu):

```bash
getent group audio
```

---

## 4. TLS certificates

**HTTPS is not optional.** Browsers refuse microphone access on any non-HTTPS
origin except localhost. Over plain HTTP, no phone or tablet on the LAN can join
a room at all.

Two workable options:

**A. Local certificate authority (recommended).** One trusted CA installed on
each device, no warnings afterwards:

```bash
sudo apt install -y libnss3-tools
curl -L -o mkcert https://github.com/FiloSottile/mkcert/releases/latest/download/mkcert-v1.4.4-linux-amd64
chmod +x mkcert && sudo mv mkcert /usr/local/bin/

mkcert -install
mkcert -cert-file certs/ssl_cert.pem -key-file certs/ssl_key.pem \
       intercom.local 192.168.1.50 localhost
```

Then install `$(mkcert -CAROOT)/rootCA.pem` on each phone and tablet once.
Downloading that file to the device and opening it is usually enough; iOS also
needs Settings → General → About → Certificate Trust Settings.

**B. Self-signed.** Works, but every device shows a warning that someone must
click through, and iOS is fussy about it:

```bash
openssl req -x509 -newkey rsa:4096 -nodes -days 3650 \
  -keyout certs/ssl_key.pem -out certs/ssl_cert.pem \
  -subj "/CN=intercom.local" \
  -addext "subjectAltName=DNS:intercom.local,IP:192.168.1.50"
```

Use the machine's real LAN IP in `subjectAltName` either way.

---

## 5. Configure

```bash
sudo mkdir -p /opt/church-intercom
sudo chown "$USER" /opt/church-intercom
# copy the project there, then:
cd /opt/church-intercom
cp .env.example .env
```

Fill in the three required values:

```bash
echo "DB_PASSWORD=$(openssl rand -base64 24)"
echo "SESSION_SECRET=$(openssl rand -hex 32)"
```

Set `AUDIO_CAPTURE_DEVICE` from §3 and name the two inputs
(`AUDIO_CHANNEL_1_NAME`, `AUDIO_CHANNEL_2_NAME`) after what is actually patched
into them — "Program" and "Talkback", or whatever the desk calls them.

Leave `ANNOUNCED_IP` blank unless the machine has more than one network
interface; the server auto-detects the LAN address.

---

## 6. Start

```bash
docker compose up -d --build
docker compose logs -f app
```

A healthy start looks like:

```
Database connected at ...
Created initial administrator account "admin"
[audio] feed "Program" (feed1) ready: channel 0 -> rtp 127.0.0.1:40122
[audio] feed "Talkback" (feed2) ready: channel 1 -> rtp 127.0.0.1:40081
[audio] capture started on hw:1,0 (2 channels)

Church Intercom listening on https://192.168.1.50:3443
```

Install the boot unit:

```bash
sudo cp deploy/church-intercom.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now church-intercom
```

Open the firewall — the RTP range is UDP and easy to forget:

```bash
sudo ufw allow 3443/tcp
sudo ufw allow 40000:40199/udp
```

---

## 7. Connecting phones and tablets

Everyone joins at `https://<server-ip>:3443` on the church Wi-Fi. Two things
have to be true, and both are easy to get wrong:

**The device must be on the same network segment.** Guest Wi-Fi is usually
isolated from the main LAN — if phones are on guest and the server is on the
wired network, nothing will connect. Check that first; it is the most common
cause of "it just spins".

**The certificate must be accepted.** With a local CA (§4A) install the root
certificate once per device and there is nothing to click afterwards. With a
self-signed certificate (§4B) each device shows a warning on every new session:

- **iOS Safari** — "Show Details" → "visit this website" → "Visit Website"
- **Android Chrome** — "Advanced" → "Proceed to … (unsafe)"

Then allow microphone access when prompted. If the prompt never appears, the
page is not on a secure origin — recheck §4.

**Give the server a fixed address.** A DHCP lease change breaks every saved
bookmark and invalidates the certificate's `subjectAltName`. Reserve the
machine's IP on the router, or give it a static address. If you also add a DNS
entry (`intercom.local`), put that name in the certificate too so the address
can change later without reissuing it.

**Install it to the home screen.** The intercom is a progressive web app, so it
can be added to a phone's home screen and run fullscreen with no browser chrome
— which also stops people losing the URL. On iOS: Share → Add to Home Screen. On
Android Chrome: menu → Install app. Sessions last 30 days, so an installed
device is signed in once and then left alone.

> Installation requires a certificate the device actually trusts. With the local
> CA from §4A this works. With a self-signed certificate accepted by exception,
> Chrome may refuse to offer installation — another reason to prefer §4A.

**Keep the phone awake and in the foreground.** The app holds a screen wake lock
while in a room, so the screen will not sleep on its own. It cannot do anything
about the user switching to another app: iOS suspends backgrounded tabs and
audio stops. For fixed positions, a cheap dedicated device that does nothing
else — screen on, app open, plugged into power — is far more reliable than
someone's personal phone.

**A dropped connection is not a lost seat.** Walking behind a wall shows
*Reconnecting…* and the session rebuilds itself automatically once Wi-Fi
returns; nobody has to rejoin. If someone is stuck on that for more than a few
seconds, the problem is Wi-Fi coverage, not the intercom.

---

## 8. Verifying audio

`/api/health` reports byte counters straight from mediasoup. A running ffmpeg
process does **not** prove audio is arriving — a muted input or wrong channel
count leaves it happily alive. Climbing `bytesReceived` is the real evidence:

```bash
curl -sk https://localhost:3443/api/health | python3 -m json.tool
```

```json
"capture": {
  "running": true,
  "feeds": [
    { "id": "feed1", "name": "Program",  "bytesReceived": 184320 },
    { "id": "feed2", "name": "Talkback", "bytesReceived": 184104 }
  ]
}
```

Run it twice a few seconds apart. Both counters should climb by roughly
12 kB/s. If one stays flat, that input is silent at the desk.

**Testing without hardware.** You can exercise the whole pipeline before the
interface is wired up, using two distinct test tones:

```bash
AUDIO_CAPTURE_FORMAT=lavfi
AUDIO_CAPTURE_DEVICE=aevalsrc=sin(440*2*PI*t)|sin(880*2*PI*t):s=48000:c=stereo
```

Feed 1 gets 440 Hz, feed 2 gets 880 Hz. If they sound different, the channel
split is correct.

---

## 9. Backups and recovery

A `pg_dump` runs nightly at 03:00 into `./backups`, kept for
`BACKUP_RETENTION_DAYS` (default 14). A logical dump survives a corrupted data
directory, which a volume copy on the same failing stick does not.

**Copy backups off the machine.** A backup on the stick that dies is not a
backup. A weekly `scp` to any other computer is enough.

Restore:

```bash
docker compose stop app
gunzip -c backups/intercom-20260729-030000.sql.gz \
  | docker compose exec -T postgres psql -U intercom -d church_intercom
docker compose start app
```

Everything except user accounts is in-memory, so a total database loss costs you
the account list and nothing else. If it ever comes to that: `docker compose
down -v`, start again (the first admin is recreated automatically), re-add
people.

**Moving the database to a real disk.** If you add an SSD, replace the
`postgres_data` volume in `docker-compose.yml` with a bind mount:

```yaml
volumes:
  - /mnt/ssd/intercom-db:/var/lib/postgresql/data
```

---

## 10. Managing people

There is no self-registration; an admin creates accounts. The first admin is
created on first boot from `BOOTSTRAP_ADMIN_USERNAME` (default `admin`) and is
ignored once any admin exists.

**On the appliance there is no authentication and no account list.** It runs
`BYPASS_AUTH=true`, which accepts any username and needs no database. Ticking
"Sign in as administrator" on the sign-in page grants admin to whoever ticks
it: kicking people from rooms, talk-to-the-building, and the sound-card
controls.

That is deliberate — volunteers need to be on air in seconds, and the box has
no route in from outside. **The network is the only control, so keep it that
way:** church LAN only, never guest Wi-Fi, never port-forwarded, never exposed
to the internet.

With a database wired up instead, an admin creates accounts, sign-in is
passwordless against that roster, and admin needs both `is_admin` on the
account and the checkbox. Revoke with `UPDATE users SET is_active = FALSE WHERE
username = '…'`. The username plays no part — an administrator can be called
anything.

Grant or revoke the capability directly:

```bash
docker compose exec db psql -U intercom -d church_intercom \
  -c "UPDATE users SET is_admin = TRUE WHERE username = 'sound-lead';"
```

`is_admin` is re-read on every admin request, so a revocation takes effect on
that person's next action rather than when their session expires.

```bash
curl -sk -X POST https://localhost:3443/api/login \
  -H 'Content-Type: application/json' \
  -d '{"usernameOrEmail":"admin","asAdmin":true}' \
  -c /tmp/c.txt

curl -sk -X POST https://localhost:3443/api/register \
  -H 'Content-Type: application/json' -b /tmp/c.txt \
  -d '{"username":"camera1","email":"camera1@church.local",
       "displayName":"Camera 1","isAdmin":false}'
```

Admins can kick people from a room and use "Talk to the Building".

---

## 11. Troubleshooting

| Symptom | Cause |
|---|---|
| Mic permission never prompts | Not HTTPS. See §4. |
| Joins, but nobody hears anything | `ANNOUNCED_IP` wrong, or UDP 40000–40199 blocked. |
| `capture.running` false, `lastError` mentions *busy* | Another process holds the card. Only one process can open an ALSA `hw:` device. |
| `lastError` mentions *No such file or directory* | Wrong `AUDIO_CAPTURE_DEVICE`. Re-check `arecord -l`. |
| Container won't start, `/dev/snd` error | No sound card present. Remove the `devices:` block and set `AUDIO_CAPTURE_ENABLED=false`. |
| Feed exists but `bytesReceived` flat | Silence at the desk, or the channel is not patched. |
| Audio works on laptops, not phones | Certificate not trusted on the device. See §4A. |

Useful commands:

```bash
docker compose logs -f app
docker compose exec app arecord -l          # what ALSA sees from inside
curl -sk https://localhost:3443/api/health  # full subsystem status
docker compose restart app
```

Set `DEBUG_AUDIO=true` for full ffmpeg output. Turn it back off afterwards — it
writes a lot, and writes cost flash endurance.

### Knowing before Sunday

A health check runs on a timer and writes to the journal, so a mid-week failure
is visible before it matters:

```bash
sudo cp deploy/church-intercom-health.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now church-intercom-health.timer
```

It runs twice daily plus Saturday evening — the Saturday run leaves a whole
evening to fix whatever it finds. It checks the health endpoint, that capture is
running when enabled, and that the USB stick is not filling up.

```bash
journalctl -u church-intercom-health --since '7 days ago'
```

To be told actively rather than having to look, set `INTERCOM_ALERT_CMD` in
`deploy/church-intercom-health.service` to any command that takes the message as
its final argument — an [ntfy.sh](https://ntfy.sh) topic is the least effort.

---

## 12. Security note — rotate the committed secrets

The repository history contains a TLS private key (`certs/ssl_key.pem`) and a
`.env`. Both were committed before `.gitignore` covered them. Anyone with repo
access has that key.

```bash
git rm --cached .env certs/ssl_key.pem certs/ssl_cert.pem
git commit -m "Stop tracking secrets and TLS material"
```

Then generate a **new** certificate (§4) rather than reusing the old one, and
set a fresh `SESSION_SECRET`. Removing the files from the current commit does
not remove them from history — treat the old key as compromised.

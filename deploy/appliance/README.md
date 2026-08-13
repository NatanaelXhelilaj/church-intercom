# Unattended appliance setup

This directory turns the intercom box into something you plug in and walk away
from: no screen, no keyboard, nobody logging in, no command typed. It targets
the **bare-metal** deployment — Node running directly on Ubuntu, which is what
the machine on the church LAN actually runs. For the Docker deployment
described in `DEPLOY.md`, use `deploy/church-intercom.service` instead.

## Install

```
sudo /home/ubuntu/church-intercom/deploy/appliance/install.sh
```

Add `--enable-wol` to also allow powering the machine on remotely with a magic
packet, and `--no-autologin` to leave the tty1 login prompt in place.

The script is idempotent — re-run it after pulling new code or editing the unit.

## What ends up on the machine

| Path | Purpose |
| --- | --- |
| `/etc/systemd/system/church-intercom.service` | Starts at boot, restarts on failure |
| `/usr/local/bin/church-intercom-run` | Resolves `ANNOUNCED_IP`, then execs the server |
| `/etc/church-intercom.env` | Port, HTTPS, `BYPASS_AUTH`, generated session secret |
| `/etc/systemd/system/getty@tty1.service.d/autologin.conf` | Console autologin |
| `/etc/systemd/logind.conf.d/00-intercom-no-idle.conf` | Never idle-suspend |
| `/etc/systemd/journald.conf.d/00-intercom-cap.conf` | Journal capped at 200M |

## The `ANNOUNCED_IP` problem

mediasoup hands `ANNOUNCED_IP` to the browser as its ICE candidate. Get it
wrong and the page loads normally, the room joins, and no audio ever arrives —
a failure that looks like a bug in the app. The appliance is on DHCP, so any
value written into a file goes stale the first time the network changes. It
already did once: the checked-in config said `192.168.18.170` while the machine
had moved to `192.168.1.100`.

So the wrapper reads the address off the interface at every boot. To pin it
instead, set `ANNOUNCED_IP` in `/etc/church-intercom.env` — better still, give
the box a DHCP reservation so its address never moves and clients can be told a
fixed URL.

## Things the software cannot do

**Power on when mains returns** is firmware. In the BIOS, set *Restore on AC
Power Loss* to **Power On** — not *Last State*, which leaves the machine off if
it was off when the plug was pulled.

## Checking on it

```
systemctl status church-intercom
journalctl -u church-intercom -f
journalctl -u church-intercom -b   # this boot only
```

The startup line `church-intercom: detected ANNOUNCED_IP=…` in the journal is
the quickest confirmation that the box came up on the address clients expect.

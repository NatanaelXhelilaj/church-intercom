#!/bin/bash
#
# One-time host preparation for the Church Intercom appliance (Debian/Ubuntu).
#
#   sudo ./deploy/appliance/bootstrap-host.sh
#
# Installs the system packages the app needs but does not ship: a current Node,
# ffmpeg for the ALSA capture path, mkcert to issue the LAN certificate, and an
# mDNS responder so phones can reach the box by name. Idempotent.
#
# Run this once, then install.sh for the systemd units.

set -euo pipefail

NODE_MAJOR=22

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "run this with sudo" >&2; exit 1; }


say "1/4  Node ${NODE_MAJOR}"

# Ubuntu 24.04 ships Node 18, but config.js and the toolchain need >= 20, so the
# distro package is not an option. NodeSource keeps /usr/bin/node current, which
# matters because the systemd unit runs an absolute path -- nvm lives in a login
# shell the service never has.
current_major="$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || echo 0)"
if [ "${current_major:-0}" -ge "$NODE_MAJOR" ]; then
    note "node $(node -v) already satisfies >= ${NODE_MAJOR}"
else
    note "found node ${current_major:-none}, installing ${NODE_MAJOR}.x"
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    chmod a+r /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq
    apt-get install -y -qq nodejs
    note "installed $(node -v)"
fi


say "2/4  Media and certificate tooling"

# ffmpeg drives the ALSA capture and playback path. mkcert issues the LAN
# certificate; libnss3-tools is what lets it write to a browser trust store, and
# mkcert warns noisily without it even on a headless box.
apt-get install -y -qq ffmpeg mkcert libnss3-tools
note "ffmpeg $(ffmpeg -version 2>/dev/null | head -n1 | cut -d' ' -f3)"
note "mkcert $(mkcert -version 2>/dev/null || echo installed)"


say "3/4  mDNS responder"

# The certificate covers <hostname>.local. That name only resolves if something
# on this machine answers multicast DNS -- without avahi the certificate is
# valid but the hostname in it goes nowhere, which is indistinguishable from a
# broken certificate when you are standing there with a phone.
apt-get install -y -qq avahi-daemon avahi-utils
systemctl enable --now avahi-daemon >/dev/null
note "$(hostname -s).local is now published on the LAN"


say "4/4  Firewall"

# WebRTC media is UDP on the RTP range, and it is a genuinely confusing failure:
# signalling succeeds over TCP, the room joins, and no audio ever flows.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "^Status: active"; then
    ufw allow 3443/tcp comment 'church intercom web' >/dev/null
    ufw allow 40000:40199/udp comment 'church intercom RTP' >/dev/null
    note "opened 3443/tcp and 40000-40199/udp"
else
    note "ufw inactive, nothing to open"
fi


cat <<EOF

Host prepared. Next:

  cd /home/ubuntu/church-intercom
  npm ci                             # rebuild against the system Node
  ./deploy/make-lan-cert.sh          # issue the LAN certificate (as ubuntu)
  sudo ./deploy/appliance/install.sh # systemd units, autologin, no-sleep
EOF

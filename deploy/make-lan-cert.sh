#!/usr/bin/env bash
#
# Issues the TLS certificate phones will accept for LAN access.
#
# Why this exists: a self-signed certificate that you click past is NOT good
# enough for this app. Browsers treat an origin with certificate errors as
# untrusted for "powerful features" — microphone capture above all — so the
# page loads, the room joins, and then audio setup stalls without ever showing
# a microphone prompt. The certificate has to chain to a CA the device really
# trusts, which means installing a local CA on each device once.
#
# Run this on the server (Linux appliance or Mac), then install certs/rootCA.pem
# on every phone and tablet — see §"Trusting the CA" in the output.
#
set -euo pipefail

cd "$(dirname "$0")/.."

# The mDNS/Bonjour name is the stable address: phones resolve <name>.local with
# no DNS setup at all, and it keeps working when DHCP moves the server to a new
# IP. The IP goes in the certificate too, as a fallback for anything on the LAN
# that cannot do multicast DNS.
case "$(uname -s)" in
  Darwin)
    HOSTNAME_LOCAL="$(scutil --get LocalHostName).local"
    DEFAULT_LAN_IP="$(ipconfig getifaddr en0 || ipconfig getifaddr en1 || true)"
    INSTALL_HINT="brew install mkcert"
    # macOS answers .local out of the box.
    MDNS_HINT=""
    ;;
  Linux)
    HOSTNAME_LOCAL="$(hostname -s).local"
    # Same detection the systemd wrapper uses: the source address the kernel
    # picks for the default route, which is the one clients can route back to.
    # Explicitly not `hostname -I`, which happily returns a Docker or Calico
    # address on a box that runs containers.
    _gw="$(ip -4 route show default 2>/dev/null | awk '{ print $3; exit }' || true)"
    DEFAULT_LAN_IP=""
    if [ -n "${_gw}" ]; then
      DEFAULT_LAN_IP="$(ip -4 route get "${_gw}" 2>/dev/null \
        | sed -n 's/.*[[:space:]]src[[:space:]]\([0-9.][0-9.]*\).*/\1/p' | head -n1 || true)"
    fi
    INSTALL_HINT="sudo apt install -y mkcert"
    # Unlike macOS, a Linux server only answers <name>.local if something is
    # publishing it. Without this the certificate is valid but the name in it
    # does not resolve, which looks identical to a broken certificate.
    MDNS_HINT="yes"
    ;;
  *)
    echo "Unsupported platform: $(uname -s)" >&2
    exit 1
    ;;
esac

if ! command -v mkcert >/dev/null 2>&1; then
  echo "mkcert is not installed. Install it with:  ${INSTALL_HINT}" >&2
  exit 1
fi

LAN_IP="${LAN_IP:-${DEFAULT_LAN_IP}}"

if [ -z "${LAN_IP}" ]; then
  echo "Could not determine this machine's LAN IP. Set it explicitly:  LAN_IP=192.168.1.50 $0" >&2
  exit 1
fi

mkdir -p certs

mkcert -cert-file certs/lan_cert.pem -key-file certs/lan_key.pem \
  "${HOSTNAME_LOCAL}" "${LAN_IP}" localhost 127.0.0.1 ::1

# The CA certificate is what gets installed on devices. Its private key
# (rootCA-key.pem) stays in mkcert's CAROOT and must never leave this machine.
cp "$(mkcert -CAROOT)/rootCA.pem" certs/rootCA.pem

# The key is a secret and lands in a world-readable checkout otherwise.
chmod 600 certs/lan_key.pem
chmod 644 certs/lan_cert.pem certs/rootCA.pem

cat <<EOF

Certificate issued for: ${HOSTNAME_LOCAL}, ${LAN_IP}, localhost

  Server cert   : certs/lan_cert.pem
  Server key    : certs/lan_key.pem
  CA for devices: certs/rootCA.pem

Point .env at it:

  HTTPS=true
  SSL_KEY_PATH=certs/lan_key.pem
  SSL_CERT_PATH=certs/lan_cert.pem

Leave ANNOUNCED_IP blank — the server detects its own LAN address at startup.
It is the address mediasoup advertises for the audio itself, and when it is
stale the page still loads and nobody can hear anything.

Trusting the CA on a device (once per device):

  iPhone/iPad  Get certs/rootCA.pem onto the device (AirDrop, or just browse to
               it), then:
               Settings > General > VPN & Device Management > install the profile
               Settings > General > About > Certificate Trust Settings >
                 turn ON full trust for the mkcert CA        <- easily missed,
                 and without it the microphone still will not work.

  Android      Copy the file over, then Settings > Security > Encryption &
               credentials > Install a certificate > CA certificate.

  A Mac        mkcert -install   (asks for your password)

Then open:  https://${HOSTNAME_LOCAL}:\${PORT:-3443}
EOF

if [ -n "${MDNS_HINT}" ]; then
  if ! systemctl is-active --quiet avahi-daemon 2>/dev/null; then
    cat <<EOF

WARNING: nothing on this machine is publishing ${HOSTNAME_LOCAL} over mDNS, so
that name will not resolve from a phone. Install the responder:

  sudo apt install -y avahi-daemon
  sudo systemctl enable --now avahi-daemon

Until then, use https://${LAN_IP}:\${PORT:-3443} — the certificate covers it.
EOF
  fi
fi

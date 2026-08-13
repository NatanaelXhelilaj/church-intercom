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
# Run this on the server Mac, then install certs/rootCA.pem on every phone and
# tablet (see §"Trusting the CA" in the output).
#
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v mkcert >/dev/null 2>&1; then
  echo "mkcert is not installed. Install it with:  brew install mkcert" >&2
  exit 1
fi

# The Bonjour name is the stable address: phones resolve <name>.local without
# any DNS setup, and it keeps working when DHCP hands the Mac a new IP.
HOSTNAME_LOCAL="$(scutil --get LocalHostName).local"
LAN_IP="${LAN_IP:-$(ipconfig getifaddr en0 || ipconfig getifaddr en1)}"

if [ -z "${LAN_IP}" ]; then
  echo "Could not determine this Mac's LAN IP. Set it explicitly:  LAN_IP=192.168.1.50 $0" >&2
  exit 1
fi

mkdir -p certs

mkcert -cert-file certs/lan_cert.pem -key-file certs/lan_key.pem \
  "${HOSTNAME_LOCAL}" "${LAN_IP}" localhost 127.0.0.1 ::1

# The CA certificate is what gets installed on devices. Its private key
# (rootCA-key.pem) stays in mkcert's CAROOT and must never leave this Mac.
cp "$(mkcert -CAROOT)/rootCA.pem" certs/rootCA.pem

cat <<EOF

Certificate issued.

  Server cert : certs/lan_cert.pem
  Server key  : certs/lan_key.pem
  CA for devices: certs/rootCA.pem

Point .env at it:

  HTTPS=true
  SSL_KEY_PATH=certs/lan_key.pem
  SSL_CERT_PATH=certs/lan_cert.pem
  ANNOUNCED_IP=${LAN_IP}

ANNOUNCED_IP is the address mediasoup advertises for the audio itself. If it is
stale, the page still loads and nobody can hear anything — re-run this script
and update it whenever the Mac's IP changes.

Trusting the CA on a device (once per device):

  iPhone/iPad  AirDrop certs/rootCA.pem, then:
               Settings > General > VPN & Device Management > install the profile
               Settings > General > About > Certificate Trust Settings >
                 turn ON full trust for the mkcert CA        <- easily missed,
                 and without it the microphone still will not work.

  Android      Copy the file over, then Settings > Security > Encryption &
               credentials > Install a certificate > CA certificate.

  This Mac     mkcert -install   (asks for your password)

Then open:  https://${HOSTNAME_LOCAL}:\${PORT:-3443}
EOF

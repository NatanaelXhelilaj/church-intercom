#!/bin/sh
#
# Periodic health check for the Church Intercom appliance.
#
# The point is to find out on Tuesday that something broke, rather than at
# 09:55 on Sunday. Run it from the systemd timer in this directory.
#
# Exits 0 when healthy, 1 when not. Output goes to the journal; read it with
#   journalctl -u church-intercom-health --since '7 days ago'
#
# Set INTERCOM_ALERT_CMD to be notified actively, e.g.
#   INTERCOM_ALERT_CMD='curl -s -X POST https://ntfy.sh/my-church-intercom -d'
# The message is appended as a single final argument.

set -u

PORT="${INTERCOM_PORT:-3443}"
SCHEME="${INTERCOM_SCHEME:-https}"
URL="$SCHEME://127.0.0.1:$PORT/api/health"

# -k because the appliance uses a self-signed or local-CA certificate and this
# request never leaves the machine.
RESPONSE="$(curl -sk --max-time 10 "$URL" 2>&1)"
CURL_STATUS=$?

fail() {
    echo "UNHEALTHY: $1"
    echo "$RESPONSE"
    if [ -n "${INTERCOM_ALERT_CMD:-}" ]; then
        # shellcheck disable=SC2086
        $INTERCOM_ALERT_CMD "Church Intercom unhealthy on $(hostname): $1"
    fi
    exit 1
}

[ $CURL_STATUS -eq 0 ] || fail "server did not respond (curl exit $CURL_STATUS)"

echo "$RESPONSE" | grep -q '"status":"ok"' || fail "health endpoint reports degraded"

# Capture is optional — a machine with no sound card is still a working
# intercom — but if it is enabled and not running, that is worth knowing about
# before someone discovers the house feed is dead during a service.
if echo "$RESPONSE" | grep -q '"enabled":true'; then
    echo "$RESPONSE" | grep -q '"running":true' \
        || fail "audio capture is enabled but not running"
fi

# Free space matters more than usual here: the OS lives on a USB stick, and a
# full filesystem takes down Docker, Postgres and the intercom together.
USAGE="$(df -P / | awk 'NR==2 {print $5}' | tr -d '%')"
[ "$USAGE" -lt 90 ] || fail "root filesystem is ${USAGE}% full"

echo "OK: intercom healthy, disk ${USAGE}% used"
exit 0

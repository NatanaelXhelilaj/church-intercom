#!/bin/bash
#
# Turn this machine into an unattended Church Intercom appliance.
#
#   sudo ./deploy/appliance/install.sh [--enable-wol] [--no-autologin]
#
# Idempotent: safe to re-run after pulling new code or changing the unit.
#
# What it does, and why each part is needed for a box that boots in a rack with
# no screen and nobody to press anything:
#
#   1. systemd service      -- starts the intercom at boot and restarts it if it
#                              ever dies. This alone removes the need for anyone
#                              to log in at all.
#   2. audio group          -- headless means no logind session, which means no
#                              ACL on /dev/snd. Group membership replaces it.
#   3. tty1 autologin       -- a console session is waiting if a screen ever does
#                              get plugged in.
#   4. no sleep/suspend     -- an intercom that suspended itself is indisputably
#                              worse than one that is merely idle.
#   5. capped journal       -- Restart=always plus a chatty server can otherwise
#                              fill the disk over months of uptime.
#   6. Wake-on-LAN (opt-in) -- lets the box be powered on remotely as well as by
#                              plugging it in.
#
# The one thing this cannot do is make the machine power up when mains returns.
# That is a firmware setting; see the closing notes it prints.

set -euo pipefail

APP_USER="ubuntu"
APP_DIR="/home/${APP_USER}/church-intercom"
ENV_FILE="/etc/church-intercom.env"
WRAPPER="/usr/local/bin/church-intercom-run"
UNIT="/etc/systemd/system/church-intercom.service"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

ENABLE_WOL=0
ENABLE_AUTOLOGIN=1

for arg in "$@"; do
    case "$arg" in
        --enable-wol)   ENABLE_WOL=1 ;;
        --no-autologin) ENABLE_AUTOLOGIN=0 ;;
        -h|--help)      sed -n '2,30p' "$0"; exit 0 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "run this with sudo" >&2; exit 1; }
[ -d "$APP_DIR" ]    || { echo "no app at $APP_DIR" >&2; exit 1; }
[ -f "$APP_DIR/server.js" ] || { echo "no server.js in $APP_DIR" >&2; exit 1; }


say "1/6  Service"

install -m 0755 "$SRC_DIR/church-intercom-run" "$WRAPPER"
note "wrapper -> $WRAPPER"

if [ -f "$ENV_FILE" ]; then
    note "keeping existing $ENV_FILE"
else
    install -m 0640 -o root -g "$APP_USER" \
        "$SRC_DIR/church-intercom.env.example" "$ENV_FILE"
    note "wrote $ENV_FILE"
fi

# Application config lives in the checkout, not here. Catch the two ways it can
# be wrong now, while someone is watching, rather than at the next cold boot.
if [ ! -f "$APP_DIR/.env" ]; then
    echo "    ERROR: $APP_DIR/.env is missing -- copy .env.example and fill it in" >&2
    exit 1
fi
if grep -qE '^BYPASS_AUTH=(1|true|yes|on)' "$APP_DIR/.env" \
   && grep -qE '^NODE_ENV=production' "$APP_DIR/.env"; then
    # config.js treats this pair as fatal and exits, which under Restart=always
    # is an invisible crash loop rather than an error anyone would notice.
    echo "    ERROR: .env sets BYPASS_AUTH with NODE_ENV=production; config.js refuses to boot" >&2
    exit 1
fi
note "app config at $APP_DIR/.env looks consistent"

install -m 0644 "$SRC_DIR/church-intercom.service" "$UNIT"
systemctl daemon-reload
systemctl enable church-intercom.service >/dev/null
note "enabled church-intercom.service"


say "2/6  Sound card access"

if id -nG "$APP_USER" | tr ' ' '\n' | grep -qx audio; then
    note "$APP_USER is already in the audio group"
else
    usermod -aG audio "$APP_USER"
    note "added $APP_USER to the audio group"
fi


say "3/6  Console autologin"

AUTOLOGIN_DIR="/etc/systemd/system/getty@tty1.service.d"
if [ "$ENABLE_AUTOLOGIN" -eq 1 ]; then
    mkdir -p "$AUTOLOGIN_DIR"
    cat > "$AUTOLOGIN_DIR/autologin.conf" <<EOF
# Log $APP_USER in on tty1 without a prompt. The intercom itself does not need
# this -- the systemd service above runs with nobody logged in -- but it means
# anyone who wheels a monitor up to the rack gets a usable shell immediately.
#
# Note the trade-off: physical access to this machine is now shell access, and
# $APP_USER is a sudoer. Fine for a locked AV rack; delete this file if the box
# ever moves somewhere public.
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin $APP_USER --noclear %I \$TERM
EOF
    systemctl daemon-reload
    note "tty1 will log in as $APP_USER automatically"
else
    rm -f "$AUTOLOGIN_DIR/autologin.conf"
    rmdir "$AUTOLOGIN_DIR" 2>/dev/null || true
    systemctl daemon-reload
    note "autologin left disabled"
fi


say "4/6  Never sleep"

systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null 2>&1 || true
mkdir -p /etc/systemd/logind.conf.d
cat > /etc/systemd/logind.conf.d/00-intercom-no-idle.conf <<'EOF'
# Headless appliance: nothing here should ever go to sleep on its own, and the
# absence of a keyboard must not read as "idle".
[Login]
IdleAction=ignore
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
EOF
note "suspend/hibernate masked, idle action ignored"


say "5/6  Log growth"

mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/00-intercom-cap.conf <<'EOF'
# Restart=always plus months of uptime can otherwise grow the journal without
# bound. 200M is far more history than this box will ever need.
[Journal]
SystemMaxUse=200M
EOF
systemctl restart systemd-journald
note "journal capped at 200M"


say "6/6  Wake-on-LAN"

IFACE="$(ip -4 route show default | awk '{ print $5; exit }')"
if [ -z "${IFACE:-}" ]; then
    note "no default-route interface found, skipping"
elif [ "$ENABLE_WOL" -eq 0 ]; then
    supported="$(ethtool "$IFACE" 2>/dev/null | awk -F': ' '/Supports Wake-on/ { print $2 }')"
    note "not enabled (re-run with --enable-wol)"
    note "$IFACE supports: ${supported:-unknown}"
else
    cat > /etc/systemd/system/wol@.service <<'EOF'
[Unit]
Description=Enable Wake-on-LAN on %i
After=network.target
[Service]
Type=oneshot
ExecStart=/usr/sbin/ethtool -s %i wol g
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now "wol@${IFACE}.service" >/dev/null
    mac="$(cat "/sys/class/net/${IFACE}/address")"
    note "enabled on $IFACE (MAC $mac)"
fi


say "Starting"
systemctl restart church-intercom.service
sleep 8
systemctl --no-pager --lines=15 status church-intercom.service || true

cat <<EOF

--------------------------------------------------------------------------
Remaining step, which no script can do for you:

  Power-on when mains returns is a firmware setting. Reboot into the BIOS
  and set "Restore on AC Power Loss" / "After Power Failure" / "AC Recovery"
  to Power On (not Last State -- Last State leaves it off if it was off when
  the plug was pulled). Save, and the box will boot the moment it has power.

Everything else is done. Useful commands:

  systemctl status church-intercom
  journalctl -u church-intercom -f
  systemctl restart church-intercom
--------------------------------------------------------------------------
EOF

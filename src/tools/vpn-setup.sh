#!/bin/sh
# NotchNux VPN: one-time setup. NotchNux never runs this; you do, once, so
# the Tray's VPN row can connect Tailscale and the Forti VPN without a
# password.
#
#   sudo sh vpn-setup.sh                       set up (Forti uses /etc/openfortivpn/config)
#   sudo sh vpn-setup.sh --config FILE         set up, Forti uses FILE
#   sudo sh vpn-setup.sh --remove              undo
#
# What it changes (each only if that VPN is installed):
#   Forti (openfortivpn)
#     /etc/systemd/system/notchnux-forti.service
#         Runs `openfortivpn -c <config>`. Never restarts by itself (a wrong
#         password can't loop and lock the account) and never starts at boot.
#     /etc/polkit-1/rules.d/50-notchnux-forti.rules
#         Lets your user start and stop that one unit, and nothing else.
#   Tailscale
#     `tailscale set --operator=<you>`: lets your user run `tailscale up/down`.
#
# Undo by hand (what --remove does):
#   rm /etc/systemd/system/notchnux-forti.service /etc/polkit-1/rules.d/50-notchnux-forti.rules
#   systemctl daemon-reload
#   tailscale set --operator=
set -eu

UNIT=notchnux-forti.service
UNIT_FILE=/etc/systemd/system/$UNIT
RULE=/etc/polkit-1/rules.d/50-notchnux-forti.rules

die() { echo "vpn-setup: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run it with sudo"

if [ "${1:-}" = "--remove" ]; then
    systemctl stop "$UNIT" 2>/dev/null || true
    rm -f "$UNIT_FILE" "$RULE"
    systemctl daemon-reload
    if command -v tailscale >/dev/null 2>&1; then tailscale set --operator= || true; fi
    echo "Removed. Forti and Tailscale need sudo again."
    exit 0
fi

CONFIG=/etc/openfortivpn/config
CONFIG_GIVEN=no
case ${1:-} in
    '') ;;
    --config) CONFIG=${2:-}; CONFIG_GIVEN=yes; [ -n "$CONFIG" ] || die "--config needs a file" ;;
    *) die "unknown option: $1" ;;
esac

USER_NAME=${SUDO_USER:-}
[ -n "$USER_NAME" ] && [ "$USER_NAME" != root ] || die "run it with sudo from your own account (SUDO_USER is empty)"
case $USER_NAME in *[!A-Za-z0-9_.-]*) die "unexpected user name: $USER_NAME" ;; esac

DONE=
FORTI=$(command -v openfortivpn || true)
# openfortivpn installed but never configured: set up Tailscale only (the
# Tray doesn't offer Forti without a config either), unless asked for a file.
if [ -n "$FORTI" ] && [ ! -f "$CONFIG" ]; then
    [ "$CONFIG_GIVEN" = no ] || die "no Forti config at $CONFIG"
    echo "vpn-setup: no Forti config at $CONFIG, so Forti is skipped (use --config FILE)" >&2
    FORTI=
fi
if [ -n "$FORTI" ]; then
    CONFIG=$(readlink -f -- "$CONFIG")   # the unit runs from /: it needs an absolute path
    case $CONFIG in *[!A-Za-z0-9_./-]*) die "unexpected config path: $CONFIG" ;; esac
    cat > "$UNIT_FILE" <<EOF
# NotchNux Forti VPN, written by vpn-setup.sh. Undo: sudo sh vpn-setup.sh --remove
[Unit]
Description=Forti VPN (openfortivpn, started from NotchNux)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$FORTI -c $CONFIG
Restart=no
EOF
    cat > "$RULE" <<EOF
// NotchNux Forti VPN, written by vpn-setup.sh. Undo: sudo sh vpn-setup.sh --remove
polkit.addRule(function (action, subject) {
    if (action.id == "org.freedesktop.systemd1.manage-units" &&
        action.lookup("unit") == "$UNIT" &&
        (action.lookup("verb") == "start" || action.lookup("verb") == "stop") &&
        subject.user == "$USER_NAME")
        return polkit.Result.YES;
});
EOF
    chmod 644 "$UNIT_FILE" "$RULE"
    systemctl daemon-reload
    DONE="$DONE Forti ($CONFIG)"
fi

if command -v tailscale >/dev/null 2>&1; then
    tailscale set --operator="$USER_NAME" || die "tailscale set --operator failed (is tailscaled running?)"
    DONE="$DONE Tailscale"
fi

[ -n "$DONE" ] || die "neither openfortivpn nor tailscale is installed"
echo "Done:$DONE. $USER_NAME can now connect them from NotchNux's Tray (VPN)."

#!/usr/bin/env bash
# Runs tests/eds-check.js against a throwaway Evolution Data Server: a private
# session bus (dbus-broker under a runtime systemd user unit, like
# headless-smoke.sh) plus private XDG config/data/cache dirs, with our own
# evolution-source-registry and evolution-calendar-factory on it. The user's
# real ~/.config/evolution and calendars are never on that bus.
# Usage: tests/eds-check.sh [CMD ARGS...]   (CMD defaults to gjs -m tests/eds-check.js)
# Exit: the command's status; 2 = the private environment could not start.
set -u

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REGISTRY=/usr/libexec/evolution-source-registry
FACTORY=/usr/libexec/evolution-calendar-factory
CALSERVER=/usr/libexec/gnome-shell-calendar-server

if ! gjs -c "imports.gi.versions.ECal = '2.0'; imports.gi.ECal" 2>/dev/null; then
    echo 'SKIP: ECal not installed'
    exit 0
fi
for bin in "$REGISTRY" "$FACTORY"; do
    [ -x "$bin" ] || { echo "SKIP: $bin not installed"; exit 0; }
done
for bin in dbus-broker-launch gdbus systemctl; do
    command -v "$bin" >/dev/null || { echo "missing: $bin" >&2; exit 2; }
done
[ -n "${XDG_RUNTIME_DIR:-}" ] || { echo "XDG_RUNTIME_DIR is not set" >&2; exit 2; }

# Short names: the socket path must stay under the 108-byte sun_path limit.
NAME="nnx-eds-$$"
UNITDIR="$XDG_RUNTIME_DIR/systemd/user"
PROFILE=$(mktemp -d "$XDG_RUNTIME_DIR/nnx-eds.XXXX") || exit 2
REAL_BUS=${DBUS_SESSION_BUS_ADDRESS:-}
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/$NAME"
[ "$DBUS_SESSION_BUS_ADDRESS" != "$REAL_BUS" ] || { echo "private bus equals the real one" >&2; exit 2; }

# Children first, so nothing gets reparented before we see it.
descendants() { local p; for p in $(pgrep -P "$1"); do descendants "$p"; echo "$p"; done; }

cleanup() {
    trap - EXIT INT TERM
    local all=() p
    # Every daemon we (or eds-check.js, restarting the factory) started.
    for p in $(cut -d' ' -f2 "$PIDFILE" 2>/dev/null); do
        # shellcheck disable=SC2207
        all+=($(descendants "$p") "$p")
    done
    if [ ${#all[@]} -gt 0 ]; then
        kill "${all[@]}" 2>/dev/null
        for _ in 1 2 3 4 5 6 7 8 9 10; do
            local alive=0
            for p in "${all[@]}"; do kill -0 "$p" 2>/dev/null && alive=1; done
            [ $alive = 0 ] && break
            sleep 0.3
        done
        kill -9 "${all[@]}" 2>/dev/null
    fi
    systemctl --user stop "$NAME.service" "$NAME.socket" 2>/dev/null
    rm -f "$UNITDIR/$NAME.service" "$UNITDIR/$NAME.socket" "$XDG_RUNTIME_DIR/$NAME"
    systemctl --user daemon-reload 2>/dev/null
    rm -rf "$PROFILE"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$PROFILE/config" "$PROFILE/data" "$PROFILE/cache" "$PROFILE/state" "$UNITDIR"
# "<name> <pid>" per daemon. eds-check.js kills and restarts the factory and
# appends the new one here, so cleanup still stops exactly what we started.
PIDFILE="$PROFILE/pids"
: > "$PIDFILE"
export NNX_EDS_PIDFILE="$PIDFILE" NNX_EDS_FACTORY="$FACTORY"

# session.conf has no <servicedir>/<standard_session_servicedirs>, so nothing
# is bus-activated: only the daemons started below exist on this bus.
cat > "$UNITDIR/$NAME.socket" <<UNIT
[Socket]
ListenStream=%t/$NAME
UNIT
cat > "$UNITDIR/$NAME.service" <<UNIT
[Service]
Type=notify
Environment=DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS
ExecStart=/usr/bin/dbus-broker-launch --scope user --config-file "${HERE//%/%%}/headless/session.conf"
UNIT
systemctl --user daemon-reload && systemctl --user start "$NAME.socket" || { echo "cannot start private bus" >&2; exit 2; }

# Everything EDS reads or writes lives under $PROFILE. GSETTINGS_BACKEND=memory
# keeps it away from the user's dconf too.
export XDG_CONFIG_HOME="$PROFILE/config" XDG_DATA_HOME="$PROFILE/data" \
       XDG_CACHE_HOME="$PROFILE/cache" XDG_STATE_HOME="$PROFILE/state" \
       GSETTINGS_BACKEND=memory GIO_USE_NETWORK_MONITOR=base
unset DBUS_STARTER_ADDRESS DBUS_STARTER_BUS_TYPE DISPLAY WAYLAND_DISPLAY

has_owner() {
    gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
        --method org.freedesktop.DBus.NameHasOwner "$1" 2>/dev/null | grep -q true
}
start_daemon() { # <binary> <bus name>
    "$1" > "$PROFILE/$(basename "$1").log" 2>&1 &
    local pid=$!
    echo "$(basename "$1") $pid" >> "$PIDFILE"
    for _ in $(seq 100); do
        has_owner "$2" && return 0
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
    done
    echo "$1 did not claim $2:" >&2
    cat "$PROFILE/$(basename "$1").log" >&2
    exit 2
}
start_daemon "$REGISTRY" org.gnome.evolution.dataserver.Sources5
start_daemon "$FACTORY" org.gnome.evolution.dataserver.Calendar8
# The shell's own calendar server (what the notch's Calendar tab listens to),
# so eds-check.js can read real CalendarServer event ids. Started when the
# binary is installed, and then it must come up: the id checks need it.
if [ -x "$CALSERVER" ]; then
    start_daemon "$CALSERVER" org.gnome.Shell.CalendarServer
    export NNX_EDS_CALSERVER=1
fi

[ $# -gt 0 ] || set -- gjs -m "$HERE/eds-check.js"
NNX_EDS_PRIVATE=1 "$@"

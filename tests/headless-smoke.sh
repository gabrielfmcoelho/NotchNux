#!/usr/bin/env bash
# Boots a throwaway headless GNOME Shell with NotchNux loaded and checks every tab.
# Usage: tests/headless-smoke.sh [--src DIR] [--tabs id,id] [--script FILE]
#                                [--data SRC:REL]... [--keep] [--out DIR]
# Exit: 0 pass, 1 a check failed, 2 the environment is unusable.
set -u

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SRC=$(cd "$HERE/.." && pwd)
OUT="$HERE/out"
TABS=''; SCRIPT=''; KEEP=0; DATA=()
UUID='notchnux@adityasah.programs'

while [ $# -gt 0 ]; do
    case $1 in
        --src) SRC=$(cd "$2" && pwd) || exit 2; shift 2 ;;
        --tabs) TABS=$2; shift 2 ;;
        --script) [ -f "$2" ] || { echo "--script: no such file: $2" >&2; exit 2; }
                  SCRIPT=$(realpath "$2"); shift 2 ;;
        --data) [ -f "${2%%:*}" ] && [[ $2 == *:* ]] || { echo "--data: want SRC:REL with an existing SRC, got: $2" >&2; exit 2; }
                DATA+=("$(realpath "${2%%:*}"):${2#*:}"); shift 2 ;;
        --keep) KEEP=1; shift ;;
        --out) mkdir -p "$2"; OUT=$(cd "$2" && pwd); shift 2 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)

for bin in gnome-shell dbus-broker-launch gdbus systemctl; do
    command -v "$bin" >/dev/null || { echo "missing: $bin" >&2; exit 2; }
done
[ -n "${XDG_RUNTIME_DIR:-}" ] || { echo "XDG_RUNTIME_DIR is not set" >&2; exit 2; }

NAME="nnx-smoke-$$"
UNITDIR="$XDG_RUNTIME_DIR/systemd/user"
PROFILE=$(mktemp -d /tmp/nnx.XXXX)
SHELL_PID=''
NNX_LOG="$PROFILE/shell.log"
NNX_OUT="$OUT"
export NNX_LOG NNX_OUT
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/$NAME"

# Print the PIDs of every descendant of $1 (children first).
descendants() { local p; for p in $(pgrep -P "$1"); do descendants "$p"; echo "$p"; done; }

cleanup() {
    trap - EXIT INT TERM
    if [ -n "$SHELL_PID" ]; then
        kids=$(descendants "$SHELL_PID")   # collect before the shell dies and they get reparented
        # shellcheck disable=SC2086
        kill "$SHELL_PID" $kids 2>/dev/null
        for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$SHELL_PID" 2>/dev/null || break; sleep 0.5; done
        # shellcheck disable=SC2086
        kill -9 "$SHELL_PID" $kids 2>/dev/null
    fi
    systemctl --user stop "$NAME.service" "$NAME.socket" 2>/dev/null
    rm -f "$UNITDIR/$NAME.service" "$UNITDIR/$NAME.socket" "$XDG_RUNTIME_DIR/$NAME"
    systemctl --user daemon-reload 2>/dev/null
    cp "$NNX_LOG" "$OUT/shell.log" 2>/dev/null
    if [ "$KEEP" = 1 ]; then echo "kept profile: $PROFILE"; else rm -rf "$PROFILE"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Isolated profile: settings keyfile, data/config/cache dirs, extension symlinks.
mkdir -p "$PROFILE/config/glib-2.0/settings" "$PROFILE/config/notchnux" "$PROFILE/cache" "$PROFILE/state" \
         "$PROFILE/data/gnome-shell/extensions" "$UNITDIR"
cat > "$PROFILE/config/glib-2.0/settings/keyfile" <<KF
[org/gnome/shell]
enabled-extensions=['unsafe@notchnux-test', '$UUID']
welcome-dialog-last-shown-version='999'
KF
compgen -G "$SRC/schemas/*.gschema.xml" >/dev/null && glib-compile-schemas "$SRC/schemas"
ln -s "$SRC" "$PROFILE/data/gnome-shell/extensions/$UUID"
ln -s "$HERE/headless/unsafe@notchnux-test" "$PROFILE/data/gnome-shell/extensions/unsafe@notchnux-test"
cp "$HERE/headless/config.json" "$PROFILE/config/notchnux/config.json"
for d in "${DATA[@]+"${DATA[@]}"}"; do
    rel=${d#*:}
    mkdir -p "$PROFILE/data/$(dirname "$rel")"
    cp "${d%%:*}" "$PROFILE/data/$rel" || exit 2
done

# Private session bus under systemd (dbus-broker refuses to run outside it).
cat > "$UNITDIR/$NAME.socket" <<UNIT
[Socket]
ListenStream=%t/$NAME
UNIT
cat > "$UNITDIR/$NAME.service" <<UNIT
[Service]
Type=notify
Environment=DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS
ExecStart=/usr/bin/dbus-broker-launch --scope user --config-file $HERE/headless/session.conf
UNIT
systemctl --user daemon-reload && systemctl --user start "$NAME.socket" || { echo "cannot start private bus" >&2; exit 2; }

unset DISPLAY WAYLAND_DISPLAY
env GSETTINGS_BACKEND=keyfile \
    XDG_DATA_HOME="$PROFILE/data" XDG_CONFIG_HOME="$PROFILE/config" XDG_CACHE_HOME="$PROFILE/cache" \
    XDG_STATE_HOME="$PROFILE/state" \
    GST_REGISTRY="${GST_REGISTRY:-$HOME/.cache/gstreamer-1.0/registry.$(uname -m).bin}" \
    gnome-shell --headless --virtual-monitor 1920x1080 > "$NNX_LOG" 2>&1 &
SHELL_PID=$!

source "$HERE/headless/lib.sh"

echo "waiting for the shell (profile $PROFILE)..."
start=$SECONDS
until [ "$(nnx_eval 'global.context.unsafe_mode')" = true ]; do
    kill -0 "$SHELL_PID" 2>/dev/null || { echo "gnome-shell exited early; see $OUT/shell.log" >&2; exit 2; }
    [ $((SECONDS - start)) -lt 180 ] || { echo "shell not ready after 180 s" >&2; exit 2; }
    sleep 1
done
echo "shell ready after $((SECONDS - start)) s"

# Wait for the extension to leave the loading states (1 = ACTIVE, 3 = ERROR).
info() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
    --method org.gnome.Shell.Extensions.GetExtensionInfo "$UUID" 2>/dev/null; }
for _ in $(seq 60); do
    state=$(info | grep -o "'state': <[0-9.]*>")
    case $state in *"<1.0>"*|*"<3.0>"*|*"<4.0>"*) break ;; esac
    sleep 0.5
done
err=$(info | sed -n "s/.*'error': <'\([^']*\)'>.*/\1/p")
if [[ $state == *"<1.0>"* && -z $err ]]; then
    echo "PASS extension-state"
else
    nnx_fail extension-state "${state:-no state} error: ${err:-none}"
    exit 1
fi
nnx_mark

if nnx_eval "$NNX.expand(), true" >/dev/null; then echo "PASS expand"; else nnx_fail expand 'expand() threw or got no answer'; fi

HUNG=0
if [ -z "$TABS" ]; then
    if list=$(nnx_eval "JSON.stringify($NNX._tabOrder)"); then
        TABS=$(printf '%s' "$list" | tr -d '[]"\\' | tr ',' ' ')
    else
        nnx_fail tab-list 'could not read _tabOrder from the shell'
    fi
else
    TABS=${TABS//,/ }
fi
if [ -z "${TABS// /}" ]; then
    [ "$NNX_FAILS" -gt 0 ] || nnx_fail tab-list 'no tabs to check'
    TABS=''
fi
echo "tabs: $TABS"
for id in $TABS; do
    if [ $HUNG = 1 ]; then echo "SKIP $id (shell unresponsive)"; continue; fi
    ok=0
    if nnx_eval "$NNX._switchTab('$id'), true" >/dev/null; then
        t0=$SECONDS
        while [ $((SECONDS - t0)) -lt 20 ]; do
            [ "$(NNX_EVAL_TIMEOUT=5 nnx_eval "$NNX._activeTab === '$id'")" = true ] && { ok=1; break; }
            sleep 0.5
        done
    fi
    if [ $ok = 1 ]; then
        sleep 0.5
        nnx_shot "tab-$id" && echo "PASS tab-$id"
    else
        if NNX_EVAL_TIMEOUT=5 nnx_eval true >/dev/null; then
            nnx_fail "tab-$id" 'did not become active within 20 s'
        else
            nnx_fail "tab-$id" 'shell stopped answering'
            HUNG=1
        fi
    fi
done

if [ -n "$SCRIPT" ]; then
    if [ $HUNG = 1 ]; then
        nnx_fail script 'skipped: shell unresponsive'
    else
        # shellcheck disable=SC1090
        source "$SCRIPT"; rc=$?
        [ $rc -eq 0 ] || nnx_fail script "exited with status $rc"
    fi
fi

errs=$(nnx_errors)
if [ -z "$errs" ]; then
    echo "PASS no-errors"
else
    nnx_fail no-errors 'NotchNux errors in the shell log:'
    printf '%s\n' "$errs"
fi

[ "$NNX_FAILS" -eq 0 ] && { echo "all checks passed"; exit 0; }
echo "$NNX_FAILS check(s) failed"
exit 1

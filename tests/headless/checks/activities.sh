# Live activities API checks (sourced by tests/headless-smoke.sh --script).
# DBUS_SESSION_BUS_ADDRESS is the smoke run's private bus, so gdbus and the CLI
# talk to the test shell, never the real session.
ACT="gdbus call --session --dest io.github.notchnux --object-path /io/github/notchnux/Activities --method io.github.notchnux.Activities"
CLI="$SRC/src/tools/notchnux-activity"

act_eq() { # name expected cmd...
    local name=$1 want=$2 got; shift 2
    got=$("$@" 2>&1)
    if [ "$got" = "$want" ]; then echo "PASS $name"; else nnx_fail "$name" "expected $want, got $got"; fi
}

# Every gdbus call is its own bus sender and a vanished sender's activities are
# reaped, so a helper process holds the sender open for the Show.
# The smoke run leaves the notch open; alerts only show on the collapsed pill.
nnx_eval "$NNX.collapse(), true" >/dev/null; sleep 1
HOLD="gjs -m $SRC/tests/headless/activity-holder.js"
$HOLD 25 "Build" "linking" "system-run-symbolic" 0.4 30 > "$NNX_OUT/hold1.txt" 2>&1 &
sleep 1.5
act_eq show a1 cat "$NNX_OUT/hold1.txt"
sleep 1
nnx_shot pill-activity 660 0 600 80
nnx_check alert-current "$NNX._alerts.current?.kind === 'act:a1'" true
act_eq update "(true,)" $ACT.Update a1 "Build" "done" 1
nnx_check update-applied "$NNX._actTable.get('a1').body === 'done'" true
act_eq update-keep "(true,)" $ACT.Update -- a1 "" "" -2
nnx_check kept "(() => { const a = $NNX._actTable.get('a1'); return [a.title, a.body, a.level]; })()" '["Build","done",1]'
act_eq end "(true,)" $ACT.End a1
act_eq end-again "(false,)" $ACT.End a1
act_eq update-unknown "(false,)" $ACT.Update -- zz "x" "" -2
nnx_check alert-gone "$NNX._alerts.current === null" true

# CLI round trip: show prints an id; update/end work from other processes on
# an activity whose sender is still alive.
id=$("$CLI" show "Copy" --body "1/3" --progress 0.3 --icon edit-copy-symbolic --timeout 20)
if [ "$id" = a2 ]; then echo "PASS cli-show ($id)"; else nnx_fail cli-show "got '$id'"; fi
sleep 1
nnx_check cli-show-reaped "$NNX._actTable.get('a2') === null" true
$HOLD 25 "Copy" "1/3" "edit-copy-symbolic" 0.3 20 > "$NNX_OUT/hold2.txt" 2>&1 &
sleep 1.5
id=$(cat "$NNX_OUT/hold2.txt")
act_eq cli-update true "$CLI" update "$id" --progress 0.9 --body "2/3"
act_eq cli-end true "$CLI" end "$id"
act_eq cli-end-again false "$CLI" end "$id"
act_eq cli-unknown false "$CLI" update zz --title x

# A sender that exits without End: its activity and bar go away.
$ACT.Show "Ghost" "" "dialog-information-symbolic" 0.5 60 >/dev/null
sleep 1
nnx_check sender-vanished "(() => { const n = $NNX; return [n._actTable._items.size, (n._alerts.current?.kind ?? '').startsWith('act:'), n._actWatches.size]; })()" '[0,false,0]'

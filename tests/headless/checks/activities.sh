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

# The smoke run leaves the notch open; alerts only show on the collapsed pill.
nnx_eval "$NNX.collapse(), true" >/dev/null; sleep 1
act_eq show "('a1',)" $ACT.Show "Build" "linking" "system-run-symbolic" 0.4 30
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

# CLI round trip, one process per call
id=$("$CLI" show Build --progress 0.2 --timeout 60)
if [ "$id" = a2 ]; then echo "PASS cli-show ($id)"; else nnx_fail cli-show "got '$id'"; fi
sleep 1
nnx_check cli-survives-sender "$NNX._actTable.get('a2') !== null" true
act_eq cli-update true "$CLI" update "$id" --progress 0.8
act_eq cli-end true "$CLI" end "$id"
act_eq cli-end-again false "$CLI" end "$id"
act_eq cli-unknown false "$CLI" update zz --title x

# A click on the bar ends the activity too.
id=$("$CLI" show Click --timeout 60)
nnx_check click-dismiss "(() => { const n = $NNX; const a = n._alerts.current; n._dismissAlert(); a.onClick(); return n._actTable.get('$id') === null; })()" true
act_eq update-after-click false "$CLI" update "$id" --title x

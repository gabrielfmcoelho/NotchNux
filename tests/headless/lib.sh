# Helpers for tests/headless-smoke.sh and feature check scripts (sourced).
# Needs in the environment: DBUS_SESSION_BUS_ADDRESS, NNX_LOG, NNX_OUT.

# Note: Eval JSON-encodes its result, so a JS string comes back double-escaped.
# Write checks that return booleans, numbers or arrays (e.g. `x === 'a'`, `a.length`),
# not JSON.stringify(...) strings, and compare against `true`, `3`, etc.
NNX="Main.extensionManager.lookup('notchnux@adityasah.programs').stateObj._notch"
NNX_FAILS=0
NNX_MARK=0

# nnx_eval <js>: print the JSON result of evaluating <js> in the shell.
# Returns 1 when the shell answers (false, ...) or does not answer in time.
nnx_eval() {
    local out q="'"
    out=$(timeout "${NNX_EVAL_TIMEOUT:-10}" gdbus call --session --dest org.gnome.Shell \
        --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" 2>/dev/null) || return 1
    case $out in
        "(true, '"*"')")
            out=${out#"(true, '"}; out=${out%"')"}
            out=${out//"\\$q"/$q}   # gdbus escapes ' inside its quoted string
            printf '%s\n' "$out" ;;
        *) return 1 ;;
    esac
}

# nnx_check <name> <js> <expected>: PASS when nnx_eval's output equals <expected>.
# nnx_wait '<js boolean>' <seconds>: poll every 0.1 s until true; non-zero on timeout
nnx_wait() {
    local i
    for ((i = 0; i < $2 * 10; i++)); do
        [ "$(nnx_eval "$1")" = true ] && return 0
        sleep 0.1
    done
    return 1
}

nnx_check() {
    local got
    got=$(nnx_eval "$2") || got='<no answer>'
    if [ "$got" = "$3" ]; then
        echo "PASS $1"
    else
        echo "FAIL $1 expected $3, got $got"
        NNX_FAILS=$((NNX_FAILS + 1))
    fi
}

# nnx_fail <name> <detail>: record a failure from custom check code.
nnx_fail() { echo "FAIL $1 $2"; NNX_FAILS=$((NNX_FAILS + 1)); }

# nnx_shot <name> [x y w h]: save $NNX_OUT/<name>.png (whole screen, or an area).
nnx_shot() {
    local f="$NNX_OUT/$1.png"
    rm -f "$f"
    if [ $# -ge 5 ]; then
        timeout 15 gdbus call --session --dest org.gnome.Shell.Screenshot \
            --object-path /org/gnome/Shell/Screenshot \
            --method org.gnome.Shell.Screenshot.ScreenshotArea "$2" "$3" "$4" "$5" false "$f" >/dev/null 2>&1
    else
        timeout 15 gdbus call --session --dest org.gnome.Shell.Screenshot \
            --object-path /org/gnome/Shell/Screenshot \
            --method org.gnome.Shell.Screenshot.Screenshot false false "$f" >/dev/null 2>&1
    fi
    [ -s "$f" ] || { nnx_fail "shot-$1" 'no screenshot written'; return 1; }
}

# nnx_pointer <x> <y> [click]: move a virtual pointer there (a real hover), and click if asked.
nnx_pointer() {
    local click=''
    [ "${3:-}" = click ] && click='d.notify_button(t + 20000, C.BUTTON_PRIMARY, C.ButtonState.PRESSED); d.notify_button(t + 40000, C.BUTTON_PRIMARY, C.ButtonState.RELEASED);'
    nnx_eval "(() => { const C = imports.gi.Clutter; const d = global.stage.context.get_backend().get_default_seat().create_virtual_device(C.InputDeviceType.POINTER_DEVICE); const t = global.get_current_time() * 1000; d.notify_absolute_motion(t, $1, $2); $click return true; })()" >/dev/null
}

# nnx_mark: forget log lines so far; nnx_errors only reports what comes after.
nnx_mark() { NNX_MARK=$(wc -l < "$NNX_LOG"); }

# nnx_errors: print JS ERROR / CRITICAL blocks that mention notchnux, since the last mark.
nnx_errors() {
    tail -n +"$((NNX_MARK + 1))" "$NNX_LOG" | awk '
        function flush() { if (buf != "" && buf ~ /notchnux/) printf "%s", buf; buf = ""; n = 0 }
        /JS ERROR|CRITICAL/ { flush(); buf = $0 "\n"; n = 1; next }
        n > 0 && n < 8 { buf = buf $0 "\n"; n++; next }
        { flush() }
        END { flush() }'
}

# Screen-share indicator checks (sourced by tests/headless-smoke.sh --script).
# A fake handle stands in for a RemoteAccessHandle; it records stop() calls.
nnx_eval "$NNX.collapse(), true" >/dev/null; sleep 1
nnx_eval "(() => { const G = imports.gi.GObject;
  const H = G.registerClass({Signals: {stopped: {}}}, class FakeH extends G.Object {
    get is_recording() { return false; }
    stop() { this.stopCalls = (this.stopCalls || 0) + 1; this.emit('stopped'); } });
  globalThis.__fh = new H(); return true; })()" >/dev/null

nnx_check share-idle "$NNX._pillShare.visible" false
nnx_check share-before-after "(() => { const n = $NNX; const h = globalThis.__fh; const b = n._pillShare.visible; n._screenShare._onNewHandle(null, h); return [b, n._pillShare.visible]; })()" '[false,true]'
nnx_check share-icon "$NNX._pillShare.icon_name === 'screen-shared-symbolic'" true
sleep 1
nnx_shot pill-share 660 0 600 80

# showScreenShare off hides it, on brings it back
nnx_check share-flag-off "(() => { const n = $NNX; n._config.setFeatureEnabled('showScreenShare', false); n._updatePrivacyIndicators(); return n._pillShare.visible; })()" false
nnx_check share-flag-on "(() => { const n = $NNX; n._config.setFeatureEnabled('showScreenShare', true); n._updatePrivacyIndicators(); return n._pillShare.visible; })()" true

# Stop path: the peek's Stop action calls handle.stop() and the icon goes away
nnx_check peek-stop "(() => { const n = $NNX; n._showScreenSharePeek(); n._notifPeekActions.get_first_child().emit('clicked', 1); return [globalThis.__fh.stopCalls, n._pillShare.visible]; })()" '[1,false]'

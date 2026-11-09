// Small shims for APIs that differ across the supported GNOME Shell
// versions (46–51). Feature-detected once at import time.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';

// St widgets: `vertical: bool` is all GNOME 46–47 have; 48 added
// `orientation` and deprecated `vertical`; 51 removed `vertical`.
// Spread one of these into a widget's constructor params.
const HAS_ORIENTATION = 'orientation' in St.BoxLayout.prototype;

export const VERTICAL = HAS_ORIENTATION
    ? { orientation: Clutter.Orientation.VERTICAL }
    : { vertical: true };

export const HORIZONTAL = HAS_ORIENTATION
    ? { orientation: Clutter.Orientation.HORIZONTAL }
    : { vertical: false };

// Unredirect inhibit: GNOME 48+ has it on Meta.Compositor (global.compositor);
// 46–47 only have the display-level functions. Both are ref-counted.
// Returns false when neither exists.
export function disableUnredirect() {
    let compositor = global.compositor ?? global.get_compositor?.();
    if (typeof compositor?.disable_unredirect === 'function') {
        compositor.disable_unredirect();
        return true;
    }
    if (typeof Meta.disable_unredirect_for_display === 'function') {
        Meta.disable_unredirect_for_display(global.display);
        return true;
    }
    return false;
}

export function enableUnredirect() {
    let compositor = global.compositor ?? global.get_compositor?.();
    if (typeof compositor?.enable_unredirect === 'function')
        compositor.enable_unredirect();
    else if (typeof Meta.enable_unredirect_for_display === 'function')
        Meta.enable_unredirect_for_display(global.display);
}

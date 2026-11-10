// The Pet tab: the pill companion's life, up close. A yard on the notch itself
// (the same player at 2x, mirroring the pill's acts, with a house it sleeps in;
// the animal leaves the pill while the yard is on screen), its name, its four
// needs each with what you can do about it, what it wears, its pockets and a
// diary by day.
//
// installCompanion(proto) adds the tab to NotchNux; _initCompanionTab() opens
// the store (~/.local/share/notchnux/companion.json). State and rules live in
// helpers/companion-store.js and helpers/companion-brain.js.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import { Companion } from '../helpers/companion.js';
import { CompanionStore, diaryDays } from '../helpers/companion-store.js';
import { WEARABLES, FINDS, thought, restAct } from '../helpers/companion-brain.js';
import { accentHex } from '../helpers/widgets.js';
import { addPressFeedback } from '../helpers/motion.js';
import { VERTICAL, HORIZONTAL } from '../helpers/compat.js';

// The rows of the Needs card, in order (the ones with two actions first).
const NEEDS = [['hunger', 'Food'], ['mood', 'Mood'], ['clean', 'Clean'], ['energy', 'Energy']];
const SLOTS = [['head', 'Head'], ['neck', 'Neck'], ['back', 'Back']];
const cap = s => s[0].toUpperCase() + s.slice(1);
const BACK_MS = 5 * 60 * 1000;   // how long "happy you're back" stays after you return

// A need's bar. The fill gets its share of the track as part of the layout
// itself: setting its width from an allocation handler cost a second layout
// pass on every frame of the dashboard opening.
const NeedBar = GObject.registerClass(
class NeedBar extends St.Widget {
    _init() {
        super._init({ style_class: 'nn-pet-bar', x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._fill = new St.Widget({ style_class: 'nn-pet-bar-fill' });
        this.add_child(this._fill);
        this._share = 0;
    }

    // share: 0..1 of the track; color: any CSS colour
    set(share, color) {
        this._share = share;
        this._fill.set_style(`background-color: ${color};`);
        this.queue_relayout();
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        let fill = new Clutter.ActorBox();
        fill.set_size(Math.max(2, Math.round(box.get_width() * this._share)), box.get_height());
        this._fill.allocate(fill);
    }
});

function label(text, cls, props = {}) {
    return new St.Label({ text, style_class: cls, y_align: Clutter.ActorAlign.CENTER, ...props });
}

function fmtTime(ms) {
    let d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function installCompanion(proto) {
    Object.assign(proto, {
        _initCompanionTab() {
            this._petStore = new CompanionStore();
            this._petStore.onChanged = () => {
                if (this._invalidateTab('companion'))
                    this._petUi?.refresh();
                this._pillRabbit?.setWear(this._petStore.state.worn);
            };
            this._pillRabbit?.setWear(this._petStore.state.worn);
        },

        _destroyCompanionTab() {
            this._petStore?.flush();
            this._petStore = null;
        },

        // The pill companion did something: needs, pantry, finds, diary.
        _onCompanionEvent(name) {
            let st = this._petStore;
            if (!st)
                return;
            switch (name) {
            case 'meal': st.meal('meal'); break;
            case 'snack': st.meal('snack'); break;
            case 'treat': st.meal('treat'); break;
            case 'dig': {
                let found = st.dig();
                if (found && this._pillRabbit)
                    this._pillRabbit.react('finished');   // a happy jump for a find
                break;
            }
            case 'pet': st.event('pet', 'got a pet'); st.petted(this._config.companion.pets); break;
            case 'groom': st.event('groom'); break;
            case 'play': st.event('play'); break;
            case 'napEnd': st.event('napEnd', 'woke from a deep nap'); break;
            case 'focusdone': st.event('focusdone'); st.earn('focusdone'); break;
            case 'finished': st.earn('finished'); break;
            case 'rain': st.rain(); break;
            case 'missed': st.event('missed', 'waited a long while for you'); break;
            case 'wake':
            case 'dayStart': this._petBackAt = Date.now(); break;
            default: break;
            }
        },

        // Needs for the brain, brought up to now; asleep when the pill says so.
        _companionNeeds() {
            if (!this._petStore)
                return null;
            let s = this._pillRabbit?._state;
            let asleep = !!s && ['sleep', 'doze'].includes(restAct(s));
            return this._petStore.needs(asleep);
        },

        _renderCompanionTab() {
            let st = this._petStore;
            let pill = this._pillRabbit;
            let panel = new St.BoxLayout({ style_class: 'notchnux-panel nn-pet', ...VERTICAL, x_expand: true });
            if (!st || !pill) {
                panel.add_child(label('Turn the companion on in Preferences → Companion.', 'nook-card-meta'));
                this._mount(panel);
                return;
            }
            let ui = { refresh: () => {} };
            this._petUi = ui;
            let card = title => {
                let c = new St.BoxLayout({ style_class: 'nook-card', ...VERTICAL, x_expand: true });
                c.add_child(label(title, 'nook-card-eyebrow'));
                panel.add_child(c);
                return c;
            };

            // ---- the yard: the same animal at 2x, following the pill's acts. No card:
            // it stands on the notch itself, and while it is on screen the animal is
            // here and not on the pill.
            let yardBox = new St.BoxLayout({ style_class: 'nn-pet-yard', ...VERTICAL, x_expand: true });
            let yard = new Companion(() => this._companionState(), { species: pill.species, scale: 2, mirror: pill });
            yard.setWear(st.state.worn);
            yard.setFlowers(st.state.flowers);
            yard.connect('notify::mapped', () => pill.setOut(yard.mapped));
            yard.connect('destroy', () => { if (this._petUi === ui) this._petUi = null; });
            yardBox.add_child(yard);

            // its name (click to change it; Enter saves, Escape cancels) and how it is
            let nameRow = new St.BoxLayout({ style_class: 'nn-pet-name-row', x_align: Clutter.ActorAlign.CENTER });
            let nameBtn = new St.Button({ style_class: 'nn-pet-name', can_focus: true });
            let nameEdit = new St.Entry({ style_class: 'nook-input nook-input-compact nn-pet-name-edit', hint_text: 'Name', can_focus: true, visible: false });
            let thoughtLabel = label('', 'nn-pet-thought');
            let editName = on => {
                nameEdit.visible = on;
                nameBtn.visible = thoughtLabel.visible = !on;
                if (on) {
                    nameEdit.set_text(this._config.companion.name);
                    nameEdit.clutter_text.grab_key_focus();
                    this._grabKeyboard(nameEdit.clutter_text);
                } else {
                    this._releaseKeyboard();
                }
            };
            nameBtn.connect('clicked', () => editName(true));
            nameEdit.clutter_text.connect('activate', () => {
                this._config.setCompanion({ name: nameEdit.get_text() });
                editName(false);
                ui.refresh();
            });
            // Connected before _makeTypable's handler, which stops Esc.
            nameEdit.clutter_text.connect('key-press-event', (a, ev) => {
                if (ev.get_key_symbol() !== Clutter.KEY_Escape)
                    return Clutter.EVENT_PROPAGATE;
                editName(false);
                return Clutter.EVENT_STOP;
            });
            this._makeTypable(nameEdit);
            for (let a of [nameBtn, nameEdit, thoughtLabel])
                nameRow.add_child(a);
            yardBox.add_child(nameRow);
            let statsLabel = label('', 'nook-card-meta', { x_align: Clutter.ActorAlign.CENTER });
            yardBox.add_child(statsLabel);
            panel.add_child(yardBox);

            // ---- needs: a bar each, with what you can do about it beside it
            // With animations off (or the pill hidden) an act cannot play: apply what it would have meant.
            let act = (play, event) => (pill._canMove() ? play() : this._onCompanionEvent(event));
            let needsCard = card('NEEDS');
            let rows = {};
            for (let [k, name] of NEEDS) {
                let row = new St.BoxLayout({ style_class: 'nn-pet-need', x_expand: true });
                row.add_child(label(name, 'nn-pet-need-label'));
                let bar = new NeedBar();
                row.add_child(bar);
                let pct = label('', 'nn-pet-need-pct');
                row.add_child(pct);
                let acts = new St.BoxLayout({ style_class: 'nn-pet-acts' });
                row.add_child(acts);
                needsCard.add_child(row);
                let hint = label('', 'nn-pet-hint', { visible: false });
                needsCard.add_child(hint);
                rows[k] = { bar, pct, acts, hint };
            }
            // An action chip in a need's row; returns { b, set(text), able(on) }.
            let btn = (need, text, fn) => {
                let b = new St.Button({ style_class: 'nook-chip', can_focus: true });
                let l = label(text, '');
                l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                b.set_child(l);
                b.connect('clicked', fn);
                addPressFeedback(b);
                rows[need].acts.add_child(b);
                return { b, set: t => l.set_text(t), able: on => { b.reactive = on; b.opacity = on ? 255 : 110; } };
            };
            let feed = btn('hunger', 'Feed', () => {
                if (st.state.pantry.food > 0)
                    act(() => pill._play('eat'), 'meal');   // (not react: a stronger act playing would drop it unseen)
            });
            let treat = btn('hunger', 'Treat', () => {
                if (st.state.pantry.treat > 0)
                    act(() => pill._play('treat'), 'treat');
            });
            btn('mood', 'Pet', () => act(() => pill._onPress(1), 'pet'));
            btn('mood', 'Play', () => act(() => pill._play('chase'), 'play'));
            // the groom act itself reports 'groom' when it ends: only the diary line is the button's
            btn('clean', 'Brush', () => { st.record('got brushed'); act(() => pill._play('groom'), 'groom'); });
            let bath = btn('clean', 'Bath', () => { if (st.bath()) pill._play('shake'); });
            let nap = btn('energy', 'Nap', () => {
                if (st.state.needs.energy <= 80)
                    act(() => pill._play('nap:nap'), 'napEnd');
            });

            // ---- what it wears (one per slot), its pockets, its diary
            let wardrobe = new St.BoxLayout({ ...VERTICAL, x_expand: true });
            card('WARDROBE').add_child(wardrobe);
            let pocketsCard = card('POCKETS');
            let pockets = new St.BoxLayout({ style_class: 'nook-chip-row', x_expand: true });
            let keepsakes = label('', 'nook-card-meta');
            pocketsCard.add_child(pockets);
            pocketsCard.add_child(keepsakes);
            let diary = new St.BoxLayout({ ...VERTICAL, x_expand: true });
            card('DIARY').add_child(diary);

            let chip = (into, text, fn, on = false) => {
                let c = new St.Button({ style_class: `nook-chip${on ? ' nook-chip-active' : ''}`, label: text, can_focus: true });
                c.connect('clicked', fn);
                addPressFeedback(c);
                into.add_child(c);
            };

            ui.refresh = () => {
                if (!panel.get_stage())
                    return;
                let s = st.state;
                let needs = st.needs();
                // an edit left behind (a click elsewhere) closes with the next change
                if (nameEdit.visible && global.stage.get_key_focus() !== nameEdit.clutter_text)
                    editName(false);
                let back = { away: false, justBack: Date.now() - (this._petBackAt ?? 0) < BACK_MS };
                nameBtn.label = this._config.companion.name || cap(pill.species);
                thoughtLabel.set_text(`is ${thought(needs, back)}`);
                let streak = st.streakDays(), pets = this._config.companion.pets;
                statsLabel.set_text(`${streak ? `${streak}-day meal streak` : 'No meal streak yet'} · petted ${pets} ${pets === 1 ? 'time' : 'times'}`);
                yard.setFlowers(s.flowers);

                for (let [k] of NEEDS) {
                    let v = k === 'hunger' ? 100 - needs.hunger : needs[k];   // the Food bar shows how full it is
                    rows[k].bar.set(Math.max(0, Math.min(1, v / 100)), v < 30 ? '#ff9f0a' : accentHex());
                    rows[k].pct.set_text(`${Math.round(v)}%`);
                }
                feed.set(`Feed · ${s.pantry.food}`);
                feed.able(s.pantry.food > 0);
                treat.set(`Treat · ${s.pantry.treat}`);
                treat.b.visible = s.pantry.treat > 0;
                bath.set(`Bath · ${s.pantry.bath}`);
                bath.b.visible = s.pantry.bath > 0;
                nap.able(needs.energy <= 80);
                // a dimmed action says why, under its row
                let hints = { hunger: s.pantry.food > 0 ? '' : 'Pantry empty, restocks at dawn',
                    energy: needs.energy <= 80 ? '' : 'Rested, no nap needed' };
                for (let [k] of NEEDS) {
                    rows[k].hint.set_text(hints[k] ?? '');
                    rows[k].hint.visible = !!hints[k];
                }

                wardrobe.destroy_all_children();
                for (let [slot, name] of SLOTS) {
                    let owned = s.items.filter(id => WEARABLES[id]?.slot === slot);
                    if (!owned.length)
                        continue;
                    let row = new St.BoxLayout({ style_class: 'nn-pet-wear', x_expand: true });
                    row.add_child(label(name, 'nn-pet-need-label'));
                    let chips = new St.BoxLayout({ style_class: 'nook-chip-row' });
                    for (let id of owned)
                        chip(chips, cap(WEARABLES[id].name.replace(/^a (tiny )?/, '')), () => st.wear(id), s.worn[slot] === id);
                    row.add_child(chips);
                    wardrobe.add_child(row);
                }
                if (!wardrobe.get_n_children())
                    wardrobe.add_child(label('Hats and collars turn up by digging and by keeping a meal streak.', 'nook-card-meta'));

                pockets.destroy_all_children();
                if (s.pantry.seed)
                    chip(pockets, `Plant seed · ${s.pantry.seed}`, () => st.plant());
                pockets.visible = s.pantry.seed > 0;
                let kept = s.items.filter(id => !WEARABLES[id]).map(id => FINDS[id]?.name.replace(/^a /, '') ?? id);
                if (s.flowers)
                    kept.push(`${s.flowers} ${s.flowers === 1 ? 'flower' : 'flowers'} planted`);
                keepsakes.set_text(kept.length ? cap(kept.join(', ')) : s.pantry.seed ? '' : 'Digging turns things up.');
                keepsakes.visible = !!keepsakes.text;

                diary.destroy_all_children();
                let days = diaryDays(s.diary, Date.now());
                if (!days.length)
                    diary.add_child(label('Nothing yet.', 'nook-card-meta'));
                for (let [i, day] of days.entries()) {
                    diary.add_child(label(day.label, `nook-card-meta${i ? ' nn-pet-day' : ''}`));
                    for (let e of day.lines) {
                        let row = new St.BoxLayout({ x_expand: true });
                        row.add_child(label(fmtTime(e.t), 'nn-pet-diary-time'));
                        row.add_child(label(e.n > 1 ? `${e.what} ×${e.n}` : e.what, 'nook-card-meta'));
                        diary.add_child(row);
                    }
                }
            };
            // back on screen: the needs have drifted meanwhile
            panel.connect('notify::mapped', () => { if (panel.mapped) ui.refresh(); });
            this._mount(panel);
            ui.refresh();
        },
    });
}

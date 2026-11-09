// The Pet tab: the pill companion's life, up close. A yard (the same player at
// 2x, mirroring the pill's acts, with a house it sleeps in), its four needs,
// things you can do for it, its pantry and finds, and a short diary.
//
// installCompanion(proto) adds the tab to NotchNux; _initCompanionTab() opens
// the store (~/.local/share/notchnux/companion.json). State and rules live in
// helpers/companion-store.js and helpers/companion-brain.js.

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import { Companion } from '../helpers/companion.js';
import { CompanionStore } from '../helpers/companion-store.js';
import { NEED_KEYS, WEARABLES, FINDS, thought, restAct } from '../helpers/companion-brain.js';
import { accentHex } from '../helpers/widgets.js';
import { addPressFeedback } from '../helpers/motion.js';
import { VERTICAL, HORIZONTAL } from '../helpers/compat.js';

const NEED_LABELS = { energy: 'Energy', hunger: 'Food', mood: 'Mood', clean: 'Clean' };
const FOOD_NAMES = { rabbit: 'Carrot', cat: 'Fish', fox: 'Berries' };

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
            case 'pet': st.event('pet', 'got a pet'); break;
            case 'groom': st.event('groom'); break;
            case 'play': st.event('play'); break;
            case 'napEnd': st.event('napEnd', 'woke from a deep nap'); break;
            case 'focusdone': st.event('focusdone'); st.earn('focusdone'); break;
            case 'finished': st.earn('finished'); break;
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
            let panel = new St.BoxLayout({ style_class: 'notchnux-panel nn-pet', ...VERTICAL, x_expand: true });
            if (!st || !this._pillRabbit) {
                panel.add_child(label('Turn the companion on in Preferences → Companion.', 'nook-card-meta'));
                this._mount(panel);
                return;
            }
            let ui = { refresh: () => {} };
            this._petUi = ui;

            // ---- the yard: the same animal at 2x, following the pill's acts
            let yardCard = new St.BoxLayout({ style_class: 'nook-card nn-pet-yard-card', ...VERTICAL, x_expand: true });
            let yard = new Companion(() => this._companionState(), {
                species: this._pillRabbit.species, scale: 2, mirror: this._pillRabbit,
            });
            yard.setWear(st.state.worn);
            yard.x_align = Clutter.ActorAlign.CENTER;
            yard.connect('destroy', () => { if (this._petUi === ui) this._petUi = null; });
            yardCard.add_child(yard);
            let thoughtLabel = label('', 'nook-card-meta nn-pet-thought', { x_align: Clutter.ActorAlign.CENTER });
            yardCard.add_child(thoughtLabel);
            panel.add_child(yardCard);

            // ---- needs
            let needsCard = new St.BoxLayout({ style_class: 'nook-card', ...VERTICAL, x_expand: true });
            needsCard.add_child(label('NEEDS', 'nook-card-eyebrow'));
            let bars = {};
            for (let k of NEED_KEYS) {
                let row = new St.BoxLayout({ style_class: 'nn-pet-need', x_expand: true });
                row.add_child(label(NEED_LABELS[k], 'nn-pet-need-label'));
                let track = new St.Widget({ style_class: 'nn-pet-bar', x_expand: true, layout_manager: new Clutter.BinLayout() });
                let fillBar = new St.Widget({ style_class: 'nn-pet-bar-fill', x_align: Clutter.ActorAlign.START, y_expand: true });
                track.add_child(fillBar);
                row.add_child(track);
                let pct = label('', 'nn-pet-need-pct');
                row.add_child(pct);
                needsCard.add_child(row);
                bars[k] = { track, fillBar, pct, value: 0 };
                // the track has no width until it is laid out; size the fill then (and on resizes)
                track.connect('notify::allocation', () => {
                    fillBar.width = Math.max(2, Math.round(track.width * bars[k].value / 100)) || 2;
                });
            }
            panel.add_child(needsCard);

            // ---- actions
            let actions = new St.BoxLayout({ style_class: 'nn-pet-actions', ...VERTICAL, x_expand: true });
            let row1 = new St.BoxLayout({ style_class: 'nook-chip-row', x_expand: true });
            let row2 = new St.BoxLayout({ style_class: 'nook-chip-row', x_expand: true });
            actions.add_child(row1);
            actions.add_child(row2);
            let btn = (text, icon, fn, into = row1) => {
                let b = new St.Button({ style_class: 'nook-chip', can_focus: true });   // icon + label, like "Silence alerts"
                let row = new St.BoxLayout();
                row.add_child(new St.Icon({ icon_name: icon, icon_size: 13, y_align: Clutter.ActorAlign.CENTER }));
                let l = label(text, '');
                l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                row.add_child(l);
                b.set_child(row);
                b.connect('clicked', fn);
                addPressFeedback(b);
                into.add_child(b);
                return b;
            };
            btn('Pet', 'emblem-favorite-symbolic', () => this._pillRabbit._onPress(1));
            let feedBtn = btn('Feed', 'emblem-ok-symbolic', () => {
                if (st.state.pantry.food > 0)
                    this._pillRabbit.react('eat');
            });
            let treatBtn = btn('Treat', 'starred-symbolic', () => {
                if (st.state.pantry.treat > 0)
                    this._pillRabbit._play('treat');
            });
            btn('Play', 'media-playback-start-symbolic', () => this._pillRabbit._play('chase'));
            btn('Brush', 'edit-clear-all-symbolic', () => { this._pillRabbit._play('groom'); st.event('groom', 'got brushed'); }, row2);
            let bathBtn = btn('Bath', 'weather-showers-symbolic', () => { if (st.bath()) this._pillRabbit._play('shake'); }, row2);
            btn('Nap', 'weather-clear-night-symbolic', () => {
                if (st.state.needs.energy <= 80)
                    this._pillRabbit._play('nap:nap');
            }, row2);
            panel.add_child(actions);

            // ---- pantry and finds
            let pantryCard = new St.BoxLayout({ style_class: 'nook-card', ...VERTICAL, x_expand: true });
            pantryCard.add_child(label('PANTRY & FINDS', 'nook-card-eyebrow'));
            let chips = new St.BoxLayout({ style_class: 'nook-chip-row nn-pet-chips', x_expand: true });
            pantryCard.add_child(chips);
            panel.add_child(pantryCard);

            // ---- diary
            let diaryCard = new St.BoxLayout({ style_class: 'nook-card', ...VERTICAL, x_expand: true });
            diaryCard.add_child(label('DIARY', 'nook-card-eyebrow'));
            let diary = new St.BoxLayout({ ...VERTICAL, x_expand: true });
            diaryCard.add_child(diary);
            panel.add_child(diaryCard);

            ui.refresh = () => {
                if (!panel.get_stage())
                    return;
                let s = st.state;
                let needs = st.needs();
                thoughtLabel.set_text(`${this._pillRabbit.species[0].toUpperCase()}${this._pillRabbit.species.slice(1)} is ${thought(needs)}`);
                for (let k of NEED_KEYS) {
                    let v = k === 'hunger' ? 100 - needs.hunger : needs[k];   // the Food bar shows how full it is
                    let w = Math.max(0, Math.min(1, v / 100));
                    bars[k].value = w * 100;
                    bars[k].fillBar.width = Math.max(2, Math.round(bars[k].track.width * w)) || 2;
                    bars[k].fillBar.set_style(`background-color: ${v < 30 ? '#ff9f0a' : accentHex()};`);
                    bars[k].pct.set_text(`${Math.round(v)}%`);
                }
                feedBtn.reactive = s.pantry.food > 0;
                feedBtn.opacity = s.pantry.food > 0 ? 255 : 110;
                treatBtn.reactive = s.pantry.treat > 0;
                treatBtn.opacity = s.pantry.treat > 0 ? 255 : 110;
                bathBtn.visible = s.pantry.bath > 0;
                chips.destroy_all_children();
                let chip = (text, fn = null, on = false) => {
                    let c = new St.Button({ style_class: `nook-chip${on ? ' nook-chip-active' : ''}`, label: text, can_focus: !!fn, reactive: !!fn });
                    if (fn) {
                        c.connect('clicked', fn);
                        addPressFeedback(c);
                    }
                    chips.add_child(c);
                };
                chip(`${FOOD_NAMES[this._pillRabbit.species]} × ${s.pantry.food}`);
                if (s.pantry.treat)
                    chip(`Treat × ${s.pantry.treat}`);
                if (s.pantry.seed)
                    chip(`Seed × ${s.pantry.seed} · plant`, () => st.plant());
                if (s.flowers)
                    chip(`Flowers ${s.flowers}`);
                for (let id of s.items) {
                    let w = WEARABLES[id];
                    if (w)
                        chip(w.name.replace(/^a (tiny )?/, ''), () => st.wear(id), s.worn[w.slot] === id);
                    else
                        chip(FINDS[id]?.name.replace(/^a /, '') ?? id);
                }
                if (!s.items.length && !s.pantry.treat)
                    chip('Digging turns things up');
                diary.destroy_all_children();
                let lines = s.diary.slice().reverse();
                if (!lines.length)
                    diary.add_child(label('Nothing yet today.', 'nook-card-meta'));
                for (let e of lines) {
                    let row = new St.BoxLayout({ x_expand: true });
                    row.add_child(label(fmtTime(e.t), 'nn-pet-diary-time'));
                    row.add_child(label(e.what, 'nook-card-meta'));
                    diary.add_child(row);
                }
            };
            // bars need their allocation: refresh once laid out, then on changes
            panel.connect('notify::mapped', () => { if (panel.mapped) ui.refresh(); });
            this._mount(panel);
            ui.refresh();
        },
    });
}

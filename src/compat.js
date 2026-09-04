/**
 * The ONLY module allowed to touch SillyTavern internals.
 *
 * Everything reachable through the supported `SillyTavern.getContext()` API goes
 * through here too, so that a future SillyTavern change needs edits in one file.
 *
 * Verified against SillyTavern 1.18.0 (release, 8172dcd0e).
 */

import { GLOBAL_DUMMY_ID } from './constants.js';
import { warn } from './log.js';

/** @returns {any} The SillyTavern context object. */
export function ctx() {
    return SillyTavern.getContext();
}

/**
 * Live Chat Completion settings (this is the same object as core's `oai_settings`,
 * st-context.js:226). Mutating it mutates SillyTavern's live state.
 */
export function settings() {
    return ctx().chatCompletionSettings;
}

/** Per-extension settings bucket, persisted in the user's settings.json. */
export function extSettings() {
    return ctx().extensionSettings;
}

/** Debounced persist of live settings (includes prompts + prompt_order). */
export function saveLive() {
    ctx().saveSettingsDebounced();
}

/** Name of the currently selected Chat Completion preset. */
export function currentPresetName() {
    return settings()?.preset_settings_openai ?? '';
}

/** @returns {any} The Chat Completion preset manager, or null. */
export function presetManager() {
    try {
        return ctx().getPresetManager('openai') ?? null;
    } catch (err) {
        warn('preset manager unavailable', err);
        return null;
    }
}

/* ------------------------------------------------------------------ *
 * Internal imports. Not exposed by getContext() in 1.18.0.
 * ------------------------------------------------------------------ */

let openaiModulePromise = null;

/**
 * Dynamically imports core's openai.js. `promptManager` is a live-binding export
 * (openai.js:526) but is absent from getContext(), so this is the only way to
 * trigger a prompt-manager re-render from an extension.
 */
async function openaiModule() {
    if (!openaiModulePromise) {
        openaiModulePromise = import('../../../../openai.js').catch(err => {
            warn('could not import openai.js; re-render will fall back to a UI nudge', err);
            return null;
        });
    }
    return openaiModulePromise;
}

/** @returns {Promise<any|null>} The PromptManager singleton, if reachable. */
export async function promptManager() {
    const mod = await openaiModule();
    return mod?.promptManager ?? null;
}

/**
 * Re-render the prompt manager after we changed prompts or prompt_order.
 *
 * `render(false)` takes the "live communication" branch (PromptManager.js:882),
 * which skips the dry-run Generate() pass — we only changed the list, not the
 * context composition, so there is nothing to recompute.
 */
export async function rerender() {
    const pm = await promptManager();
    if (pm && typeof pm.render === 'function') {
        pm.render(false);
        return true;
    }
    return false;
}

/**
 * The character id whose prompt_order list drives Chat Completion.
 * Real presets can contain a stale 100000 list alongside the live 100001 one,
 * so this must never be resolved by array index.
 */
export async function orderCharacterId() {
    const pm = await promptManager();
    const id = pm?.configuration?.promptOrder?.dummyId;
    return id ?? GLOBAL_DUMMY_ID;
}

/**
 * Persist the live settings into the selected preset FILE by triggering
 * SillyTavern's own "Update current preset" control (openai.js:6766).
 *
 * Reusing the real button keeps us on core's exact save path — same field
 * whitelist, same in-memory preset refresh — instead of reimplementing it.
 */
export function savePresetFile() {
    const button = document.getElementById('update_oai_preset');
    if (!button) return false;
    button.click();
    return true;
}

/* ------------------------------------------------------------------ *
 * UI helpers (all supported API).
 * ------------------------------------------------------------------ */

export function toast() {
    return globalThis.toastr;
}

export async function confirmPopup(text, title = '') {
    const { Popup, POPUP_TYPE } = ctx();
    const popup = new Popup(text, POPUP_TYPE.CONFIRM, '', { okButton: 'Apply', cancelButton: 'Cancel', wide: true, ...(title ? { title } : {}) });
    const result = await popup.show();
    return Boolean(result);
}

export async function textPopup(html, { wide = true, large = false } = {}) {
    const { callGenericPopup, POPUP_TYPE } = ctx();
    return callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide, large, allowVerticalScrolling: true });
}

export async function inputPopup(label, defaultValue = '') {
    const { callGenericPopup, POPUP_TYPE } = ctx();
    return callGenericPopup(label, POPUP_TYPE.INPUT, defaultValue, {});
}

export function uuid() {
    try {
        return ctx().uuidv4();
    } catch {
        return `pm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
}

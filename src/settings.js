/**
 * State lives in two places, deliberately:
 *
 *  - extension_settings[MODULE_NAME]  — per-user UI state (collapse, options) and
 *    the shared module library. Persisted to the user's settings.json. Keeping
 *    collapse state here means clicking a chevron never dirties a preset.
 *
 *  - preset.extensions.promptModules   — per-preset sync links. This is an official
 *    SillyTavern field (openai.js:400 whitelist, :508 default, :4930 preset switch)
 *    that travels with preset save/export/import/rename and is ignored by stock
 *    SillyTavern, so removing this extension leaves presets completely valid.
 *    Written only when a module actually takes part in sharing.
 */

import { MODULE_NAME, NS, DEFAULT_HEADER_CHARS } from './constants.js';
import { extSettings, saveLive, presetManager, currentPresetName, settings as liveSettings } from './compat.js';
import { warn } from './log.js';

const DEFAULTS = {
    enabled: true,
    /** Characters that mark a prompt name as a module header. */
    headerChars: DEFAULT_HEADER_CHARS,
    /** Also treat any prompt with empty content as a header. Off: real headers may have content. */
    treatEmptyAsHeader: false,
    /** Show the "n prompts (m on)" badge on header rows. */
    showCounts: true,
    /** Dragging a collapsed header moves its whole module. */
    moveModuleOnDrag: true,
    /** { [presetName]: { [headerIdentifier]: true } } */
    collapsed: {},
    /** { [libraryKey]: exportPayload } */
    library: {},
    /** Last destructive operation, for one-click undo. */
    undo: null,
};

export function getSettings() {
    const all = extSettings();
    if (!all[MODULE_NAME]) all[MODULE_NAME] = {};
    const mine = all[MODULE_NAME];
    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (mine[key] === undefined) {
            mine[key] = structuredClone(value);
        }
    }
    return mine;
}

export function save() {
    saveLive();
}

/* ---------------------------- collapse state ---------------------------- */

function collapseBucket() {
    const s = getSettings();
    const preset = currentPresetName() || '__unnamed__';
    if (!s.collapsed[preset]) s.collapsed[preset] = {};
    return s.collapsed[preset];
}

export function isCollapsed(headerIdentifier) {
    return Boolean(collapseBucket()[headerIdentifier]);
}

export function setCollapsed(headerIdentifier, collapsed) {
    const bucket = collapseBucket();
    if (collapsed) {
        bucket[headerIdentifier] = true;
    } else {
        delete bucket[headerIdentifier];
    }
    save();
}

/**
 * Collapse state is filed under the preset's name, so a rename would orphan it
 * and pop every module open. Core emits PRESET_RENAMED, so move the bucket across.
 */
export function renameCollapseBucket(oldName, newName) {
    const s = getSettings();
    if (!oldName || !newName || oldName === newName) return;
    const bucket = s.collapsed[oldName];
    if (!bucket) return;
    s.collapsed[newName] = { ...(s.collapsed[newName] ?? {}), ...bucket };
    delete s.collapsed[oldName];
    save();
}

export function forgetCollapseBucket(presetName) {
    const s = getSettings();
    if (presetName && s.collapsed[presetName]) {
        delete s.collapsed[presetName];
        save();
    }
}

export function setAllCollapsed(headerIdentifiers, collapsed) {
    const bucket = collapseBucket();
    for (const id of headerIdentifiers) {
        if (collapsed) bucket[id] = true;
        else delete bucket[id];
    }
    save();
}

/* ---------------------------- module library ----------------------------- */

export function getLibrary() {
    return getSettings().library;
}

export function putLibraryEntry(key, payload) {
    getSettings().library[key] = payload;
    save();
}

export function deleteLibraryEntry(key) {
    delete getSettings().library[key];
    save();
}

/* ------------------------- per-preset sync links ------------------------- */

/**
 * Cache, because the model is derived on every re-decoration and reading the
 * field walks the whole preset list. Invalidated on preset change and on write.
 */
let metaCache = null;
let metaCacheKey = null;

export function invalidatePresetMeta() {
    metaCache = null;
    metaCacheKey = null;
}

/**
 * Read this extension's metadata from a preset's official `extensions` bucket.
 * @param {string} [presetName] Defaults to the selected preset.
 * @returns {{v:number, links:object, members:Record<string,string>}}
 */
export function readPresetMeta(presetName) {
    const key = presetName ?? currentPresetName();
    if (metaCache && metaCacheKey === key) return metaCache;

    const empty = { v: 1, links: {}, members: {} };
    const pm = presetManager();
    if (!pm?.readPresetExtensionField) return empty;
    try {
        const value = pm.readPresetExtensionField({ name: presetName, path: NS });
        const meta = (value && typeof value === 'object')
            ? { v: value.v ?? 1, links: value.links ?? {}, members: value.members ?? {} }
            : empty;
        metaCache = meta;
        metaCacheKey = key;
        return meta;
    } catch (err) {
        warn('could not read preset metadata', err);
    }
    return empty;
}

/**
 * Explicit module membership: `{ [promptIdentifier]: headerIdentifier }`.
 *
 * Membership is opt-in. A prompt sitting under a header is NOT a member until it
 * is put there — by dragging it in, by the row toggle, or by adopting a module.
 * @returns {Record<string,string>}
 */
export function getMemberships() {
    return readPresetMeta().members ?? {};
}

/**
 * Apply membership changes in one write.
 * @param {Array<[string,string]>} assign Pairs of [promptIdentifier, headerIdentifier].
 * @param {string[]} [remove] Prompt identifiers to make module-less.
 */
export async function updateMemberships(assign = [], remove = []) {
    const meta = readPresetMeta();
    const members = { ...(meta.members ?? {}) };
    let changed = false;

    for (const [promptId, headerId] of assign) {
        if (members[promptId] !== headerId) {
            members[promptId] = headerId;
            changed = true;
        }
    }
    for (const promptId of remove) {
        if (promptId in members) {
            delete members[promptId];
            changed = true;
        }
    }

    // Drop relationships for prompts that no longer exist — deleted through our
    // own module removal, or through SillyTavern's delete/detach controls.
    const alive = new Set((liveSettings()?.prompts ?? []).filter(Boolean).map(p => p.identifier));
    if (alive.size) {
        for (const [promptId, headerId] of Object.entries(members)) {
            if (!alive.has(promptId) || !alive.has(headerId)) {
                delete members[promptId];
                changed = true;
            }
        }
        for (const headerId of Object.keys(meta.links ?? {})) {
            if (!alive.has(headerId)) {
                delete meta.links[headerId];
                changed = true;
            }
        }
    }

    if (!changed) return false;

    meta.members = members;
    await writePresetMeta(meta);
    return true;
}

/**
 * Wipe every trace that a module ever existed, in one write: the membership of
 * each listed prompt, and the header's own sync link.
 *
 * Removing a module returns its prompts to plain, unassigned prompts. Nothing
 * remembers the arrangement, so re-adding the same header later gives a fresh
 * empty module rather than silently resurrecting the old membership.
 */
export async function clearModuleMeta(headerIdentifier, promptIdentifiers = []) {
    const meta = readPresetMeta();
    const members = { ...(meta.members ?? {}) };
    let changed = false;

    for (const id of [headerIdentifier, ...promptIdentifiers]) {
        if (id && id in members) {
            delete members[id];
            changed = true;
        }
    }
    // Anything still pointing at this header is part of the same arrangement.
    for (const [promptId, headerId] of Object.entries(members)) {
        if (headerId === headerIdentifier) {
            delete members[promptId];
            changed = true;
        }
    }
    if (meta.links && headerIdentifier in meta.links) {
        delete meta.links[headerIdentifier];
        changed = true;
    }
    if (!changed) return false;

    meta.members = members;
    await writePresetMeta(meta);
    return true;
}

/**
 * Write this extension's metadata back. Note this writes the preset FILE
 * immediately (preset-manager.js:900), so only call it when links actually change.
 */
export async function writePresetMeta(meta, presetName) {
    const pm = presetManager();
    if (!pm?.writePresetExtensionField) return false;
    try {
        await pm.writePresetExtensionField({ name: presetName, path: NS, value: meta });
        metaCache = meta;
        metaCacheKey = presetName ?? currentPresetName();
        return true;
    } catch (err) {
        warn('could not write preset metadata', err);
        invalidatePresetMeta();
        return false;
    }
}

/* --------------------------------- undo --------------------------------- */

export function setUndo(snapshot) {
    getSettings().undo = snapshot;
    save();
}

export function getUndo() {
    return getSettings().undo;
}

export function clearUndo() {
    getSettings().undo = null;
    save();
}

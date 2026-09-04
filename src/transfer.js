/**
 * Feature 2 — export / import / update of a whole module.
 *
 * Design constraints, all verified against SillyTavern 1.18.0:
 *
 *  - We never call core's `PromptManager.import()`. It applies prompt_order with
 *    `Object.assign(orderArray, incoming)` (PromptManager.js:1854), an index-based
 *    overwrite that scrambles order and can duplicate identifiers.
 *  - Our export file is a SUPERSET of core's envelope that deliberately omits
 *    `data.prompt_order`. Such a file still passes core's validateObject, and
 *    since `Object.assign(target, undefined)` is a no-op, importing one with
 *    SillyTavern's own button can only add/update prompts — never reorder them.
 *  - Prompt objects are mutated in place (Object.assign), matching core's own
 *    idiom, so unrelated fields on a prompt are preserved.
 */

import { FORMAT_VERSION, EXPORT_TYPE, SYNCED_PROMPT_FIELDS } from './constants.js';
import { settings as liveSettings, saveLive, rerender, uuid, currentPresetName } from './compat.js';
import {
    deriveModel, normalizeName, findModuleByHeaderId, findModuleByName, moduleRange, getOrderList,
} from './modules.js';
import {
    readPresetMeta, writePresetMeta, setUndo, getUndo, clearUndo, clearModuleMeta, setCollapsed,
} from './settings.js';
import { debug, warn } from './log.js';

/* --------------------------------- export -------------------------------- */

function ensureLinks(meta, module) {
    if (!meta.links[module.id]) {
        meta.links[module.id] = { moduleKey: uuid(), memberKeys: {} };
    }
    const link = meta.links[module.id];
    if (!link.memberKeys) link.memberKeys = {};
    for (const member of module.members) {
        if (!link.memberKeys[member.prompt.identifier]) {
            link.memberKeys[member.prompt.identifier] = uuid();
        }
    }
    return link;
}

function cleanPrompt(prompt) {
    const copy = structuredClone(prompt);
    // `enabled` on a prompt object is vestigial in core (the real flag lives in
    // prompt_order); drop it so an exported file cannot imply otherwise.
    delete copy.enabled;
    return copy;
}

/**
 * Build a portable payload for one module and remember its stable keys in the
 * source preset, so later syncs match exactly rather than by name.
 */
export async function buildModulePayload(headerIdentifier) {
    const model = deriveModel();
    const module = findModuleByHeaderId(model, headerIdentifier);
    if (!module) throw new Error('Module not found');

    const meta = readPresetMeta();
    const link = ensureLinks(meta, module);
    await writePresetMeta(meta);

    const members = module.members.map(member => ({
        key: link.memberKeys[member.prompt.identifier],
        identifier: member.prompt.identifier,
        name: member.prompt.name,
        normalized: normalizeName(member.prompt.name),
        enabled: Boolean(member.entry?.enabled),
    }));

    return {
        version: FORMAT_VERSION,
        type: EXPORT_TYPE,
        // Stock-compatible payload. Header first, then members in display order.
        data: {
            prompts: [cleanPrompt(module.header), ...module.members.map(m => cleanPrompt(m.prompt))],
        },
        promptModules: {
            v: FORMAT_VERSION,
            module: {
                key: link.moduleKey,
                name: module.header.name,
                normalized: module.normalized,
                headerIdentifier: module.id,
                headerEnabled: Boolean(module.headerEntry?.enabled),
            },
            members,
            source: { preset: currentPresetName() },
        },
    };
}

export function validatePayload(payload) {
    if (!payload || typeof payload !== 'object') return 'Not a JSON object.';
    const pm = payload.promptModules;
    if (!pm || typeof pm !== 'object') return 'Missing "promptModules" section — this is not a module file.';
    if (!pm.module?.name) return 'Missing module name.';
    if (!Array.isArray(payload?.data?.prompts) || !payload.data.prompts.length) return 'Missing prompt data.';
    if (!Array.isArray(pm.members)) return 'Missing member list.';
    return null;
}

/* -------------------------------- matching ------------------------------- */

/** Locate the module in the current preset that corresponds to a payload. */
export function matchModule(payload, model = deriveModel()) {
    const pm = payload.promptModules;
    const meta = readPresetMeta();

    for (const [headerId, link] of Object.entries(meta.links ?? {})) {
        if (link?.moduleKey && link.moduleKey === pm.module.key) {
            const byLink = findModuleByHeaderId(model, headerId);
            if (byLink) return { module: byLink, how: 'stable key' };
        }
    }

    const byIdentifier = findModuleByHeaderId(model, pm.module.headerIdentifier);
    if (byIdentifier) return { module: byIdentifier, how: 'prompt identifier' };

    const byName = findModuleByName(model, pm.module.normalized || normalizeName(pm.module.name));
    if (byName) return { module: byName, how: 'module name' };

    return { module: null, how: null };
}

function matchMember(incoming, module, link, usedIdentifiers) {
    // Search prompts that have joined the module AND prompts merely sitting in its
    // span. Without the latter, importing into a module whose prompts were never
    // adopted would treat every one of them as missing and add a duplicate
    // alongside it. A matched candidate is updated in place and enrolled.
    const candidates = [...module.members, ...module.candidates]
        .filter(m => !usedIdentifiers.has(m.prompt.identifier));

    if (incoming.key && link?.memberKeys) {
        const hit = candidates.find(m => link.memberKeys[m.prompt.identifier] === incoming.key);
        if (hit) return { member: hit, how: 'stable key' };
    }
    const byId = candidates.find(m => m.prompt.identifier === incoming.identifier);
    if (byId) return { member: byId, how: 'prompt identifier' };

    const wanted = incoming.normalized || normalizeName(incoming.name);
    const byName = candidates.find(m => normalizeName(m.prompt.name) === wanted);
    if (byName) return { member: byName, how: 'name' };

    return { member: null, how: null };
}

/* ---------------------------------- diff --------------------------------- */

/**
 * Compare a payload against the current preset without changing anything.
 * @returns {{mode:'create'|'update', matchedBy:string|null, target:any,
 *            header:{incoming:any,target:any}|null,
 *            updates:Array, additions:Array, extras:Array}}
 */
export function buildDiff(payload) {
    const model = deriveModel();
    const pm = payload.promptModules;
    const promptsByName = new Map();
    for (const p of payload.data.prompts) promptsByName.set(p.identifier, p);

    const incomingHeader = payload.data.prompts[0];
    const { module, how } = matchModule(payload, model);

    if (!module) {
        return {
            mode: 'create',
            matchedBy: null,
            target: null,
            header: { incoming: incomingHeader, target: null },
            updates: [],
            additions: pm.members.map(m => ({ incoming: m, prompt: promptsByName.get(m.identifier) })).filter(a => a.prompt),
            extras: [],
        };
    }

    const meta = readPresetMeta();
    const link = meta.links?.[module.id];
    const used = new Set();
    const updates = [];
    const additions = [];

    pm.members.forEach((incoming, position) => {
        const prompt = promptsByName.get(incoming.identifier);
        if (!prompt) return;
        const { member, how: memberHow } = matchMember(incoming, module, link, used);
        if (member) {
            used.add(member.prompt.identifier);
            updates.push({ incoming, prompt, target: member, matchedBy: memberHow, position, changed: hasChanges(member.prompt, prompt) });
        } else {
            additions.push({ incoming, prompt, position });
        }
    });

    const extras = module.members.filter(m => !used.has(m.prompt.identifier));

    return {
        mode: 'update',
        matchedBy: how,
        target: module,
        header: { incoming: incomingHeader, target: module.header },
        updates,
        additions,
        extras,
    };
}

function hasChanges(targetPrompt, incomingPrompt) {
    return SYNCED_PROMPT_FIELDS.some(field => {
        const a = targetPrompt?.[field];
        const b = incomingPrompt?.[field];
        if (Array.isArray(a) || Array.isArray(b)) {
            return JSON.stringify(a ?? []) !== JSON.stringify(b ?? []);
        }
        return (a ?? '') !== (b ?? '');
    });
}

/* --------------------------------- apply --------------------------------- */

function snapshot() {
    const s = liveSettings();
    return {
        preset: currentPresetName(),
        prompts: structuredClone(s.prompts),
        prompt_order: structuredClone(s.prompt_order),
    };
}

function copyFields(target, incoming) {
    for (const field of SYNCED_PROMPT_FIELDS) {
        if (incoming[field] !== undefined) {
            target[field] = structuredClone(incoming[field]);
        }
    }
}

function freshPromptFrom(incoming, existingIds) {
    const copy = structuredClone(incoming);
    delete copy.enabled;
    if (!copy.identifier || existingIds.has(copy.identifier)) {
        copy.identifier = uuid();
    }
    if (copy.system_prompt === undefined) copy.system_prompt = false;
    if (copy.marker === undefined) copy.marker = false;
    return copy;
}

/**
 * Materialise an incoming prompt in the target preset.
 *
 * A prompt can exist in `prompts` while being absent from `prompt_order` — core
 * calls these orphans, and they are reachable only from the footer's "insert
 * prompt" dropdown. Real presets accumulate them. If the incoming member IS such
 * an orphan, adopt and refresh it instead of pushing a duplicate object with a
 * new identifier, which would otherwise pile up on every import.
 */
function materialisePrompt(incomingPrompt, { prompts, listedIds, existingIds }) {
    const existing = prompts.find(p => p?.identifier === incomingPrompt.identifier);
    if (existing && !listedIds.has(existing.identifier)) {
        copyFields(existing, incomingPrompt);
        return existing;
    }
    const fresh = freshPromptFrom(incomingPrompt, existingIds);
    existingIds.add(fresh.identifier);
    prompts.push(fresh);
    return fresh;
}

/**
 * Apply a diff to the live preset.
 *
 * @param {object} diff From buildDiff().
 * @param {object} payload The original payload.
 * @param {object} options
 * @param {boolean} options.updateExisting Update matched members' content.
 * @param {boolean} options.updateHeader   Update the header prompt itself.
 * @param {boolean} options.addNew         Add members present only in the source.
 * @param {boolean} options.removeExtras   Remove members present only in the target.
 * @param {boolean} options.applyEnabled   Take enabled flags from the source.
 * @param {boolean} options.reorder        Match the source's member order.
 * @param {'end'|'top'} options.placement  Where a NEW module is inserted.
 */
export async function applyDiff(diff, payload, options) {
    const before = snapshot();
    const s = liveSettings();
    const model = deriveModel();
    const orderList = model.orderList;
    const existingIds = new Set(s.prompts.filter(Boolean).map(p => p.identifier));
    const stats = { updated: 0, added: 0, removed: 0, reordered: false, created: false };

    const meta = readPresetMeta();
    const pm = payload.promptModules;
    // Membership is opt-in, so imported prompts must be enrolled explicitly —
    // landing inside a header's span is not enough to make them members.
    meta.members = { ...(meta.members ?? {}) };
    const enrol = (promptId, headerId) => { meta.members[promptId] = headerId; };

    const listedIds = new Set(orderList.map(e => e?.identifier).filter(Boolean));
    const pool = { prompts: s.prompts, listedIds, existingIds };

    if (diff.mode === 'create') {
        const header = materialisePrompt(diff.header.incoming, pool);
        listedIds.add(header.identifier);

        const entries = [{ identifier: header.identifier, enabled: pm.module.headerEnabled !== false }];
        for (const addition of diff.additions) {
            const prompt = materialisePrompt(addition.prompt, pool);
            listedIds.add(prompt.identifier);
            entries.push({ identifier: prompt.identifier, enabled: Boolean(addition.incoming.enabled) });
            enrol(prompt.identifier, header.identifier);
            stats.added++;
        }

        if (options.placement === 'top') orderList.unshift(...entries);
        else orderList.push(...entries);

        meta.links[header.identifier] = {
            moduleKey: pm.module.key,
            memberKeys: Object.fromEntries(
                entries.slice(1).map((entry, i) => [entry.identifier, pm.members[i]?.key ?? uuid()]),
            ),
        };
        stats.created = true;
    } else {
        const module = diff.target;

        if (options.updateHeader && diff.header.target) {
            copyFields(diff.header.target, diff.header.incoming);
        }

        if (options.updateExisting) {
            for (const update of diff.updates) {
                copyFields(update.target.prompt, update.prompt);
                if (options.applyEnabled && update.target.entry) {
                    update.target.entry.enabled = Boolean(update.incoming.enabled);
                }
                enrol(update.target.prompt.identifier, module.id);
                stats.updated++;
            }
        }

        const link = meta.links[module.id] ?? { moduleKey: pm.module.key, memberKeys: {} };
        link.moduleKey = pm.module.key;
        link.memberKeys = link.memberKeys ?? {};
        for (const update of diff.updates) {
            if (update.incoming.key) link.memberKeys[update.target.prompt.identifier] = update.incoming.key;
        }

        // Insert additions immediately after the module's current last entry.
        if (options.addNew && diff.additions.length) {
            const { end } = moduleRange(module);
            const newEntries = [];
            for (const addition of diff.additions) {
                const prompt = materialisePrompt(addition.prompt, pool);
                listedIds.add(prompt.identifier);
                newEntries.push({ identifier: prompt.identifier, enabled: Boolean(addition.incoming.enabled) });
                enrol(prompt.identifier, module.id);
                if (addition.incoming.key) link.memberKeys[prompt.identifier] = addition.incoming.key;
                stats.added++;
            }
            orderList.splice(end, 0, ...newEntries);
        }

        // Extras are de-listed, never deleted: the prompt object stays in `prompts`
        // so it remains recoverable from the footer "insert prompt" dropdown.
        if (options.removeExtras && diff.extras.length) {
            const doomed = new Set(diff.extras.map(m => m.prompt.identifier));
            for (let i = orderList.length - 1; i >= 0; i--) {
                if (doomed.has(orderList[i]?.identifier)) {
                    delete meta.members[orderList[i].identifier];
                    orderList.splice(i, 1);
                    stats.removed++;
                }
            }
        }

        meta.links[module.id] = link;

        if (options.reorder) {
            stats.reordered = reorderModule(module.id, pm, link, orderList);
        }
    }

    await writePresetMeta(meta);
    setUndo({ ...before, label: pm.module.name });
    saveLive();
    await rerender();
    debug('applied module payload', stats);
    return stats;
}

/**
 * Rearrange a module's member entries to follow the source order. Members that the
 * source does not know about keep their relative order and stay at the end.
 */
function reorderModule(headerId, pm, link, orderList) {
    const model = deriveModel();
    const module = findModuleByHeaderId(model, headerId);
    if (!module || module.members.length < 2) return false;

    const rank = new Map();
    pm.members.forEach((member, index) => {
        const identifier = Object.entries(link.memberKeys ?? {})
            .find(([, key]) => key === member.key)?.[0];
        if (identifier) rank.set(identifier, index);
    });
    if (!rank.size) return false;

    const { start, end } = moduleRange(module);
    const slice = orderList.slice(start + 1, end);
    const sorted = [...slice].sort((a, b) => {
        const ra = rank.has(a.identifier) ? rank.get(a.identifier) : Number.MAX_SAFE_INTEGER;
        const rb = rank.has(b.identifier) ? rank.get(b.identifier) : Number.MAX_SAFE_INTEGER;
        return ra - rb;
    });
    if (sorted.every((entry, i) => entry === slice[i])) return false;

    orderList.splice(start + 1, slice.length, ...sorted);
    return true;
}

/* ------------------------------ delete a module ---------------------------- */

/**
 * Remove a module, in one of three escalating steps.
 *
 * The default matches what SillyTavern's own red "Remove" chain does: the prompt
 * leaves prompt_order but the prompt OBJECT survives, so it can be put back from
 * the footer's "insert prompt" dropdown. Only `deleteContents` actually erases
 * anything, and even then a snapshot is taken first so Undo still works.
 *
 * @param {object} options
 * @param {boolean} options.removeContents De-list the module's members as well.
 * @param {boolean} options.deleteContents Erase the header and members entirely.
 *
 * Prompts SillyTavern protects are skipped by BOTH steps. That matters most for
 * de-listing: markers such as chatHistory are load-bearing, and dropping one from
 * prompt_order silently stops that content being sent at all.
 */
export async function deleteModule(headerIdentifier, { removeContents = false, deleteContents = false } = {}) {
    const before = snapshot();
    const s = liveSettings();
    const module = findModuleByHeaderId(deriveModel(), headerIdentifier);
    if (!module) return null;

    const takeMembers = removeContents || deleteContents;
    const targets = [module.header, ...(takeMembers ? module.members.map(m => m.prompt) : [])];
    const allowed = targets.filter(p => p && !p.system_prompt && !p.marker);
    const skipped = targets.length - allowed.length;
    const ids = new Set(allowed.map(p => p.identifier));

    const orderList = getOrderList(s);
    for (let i = orderList.length - 1; i >= 0; i--) {
        if (ids.has(orderList[i]?.identifier)) orderList.splice(i, 1);
    }

    if (deleteContents) {
        s.prompts = s.prompts.filter(p => !p || !ids.has(p.identifier));
    }

    // Removing a module erases the arrangement completely, whether or not anything
    // was deleted: the header and every prompt that was in it go back to being
    // plain unassigned prompts. Keeping the membership would mean re-adding the
    // same header later silently resurrects the old module, which makes splitting
    // and rebuilding modules behave unpredictably.
    setCollapsed(headerIdentifier, false);
    await clearModuleMeta(headerIdentifier, module.members.map(m => m.prompt.identifier));

    setUndo({ ...before, label: String(module.header.name ?? 'module').trim() });
    saveLive();
    await rerender();
    return {
        removed: allowed.length,
        skipped,
        deleted: deleteContents ? allowed.length : 0,
        keptContents: !takeMembers,
    };
}

/* ---------------------------------- undo --------------------------------- */

export function canUndo() {
    const undo = getUndo();
    return Boolean(undo && undo.preset === currentPresetName());
}

export async function undoLast() {
    const undo = getUndo();
    if (!undo) return false;
    if (undo.preset !== currentPresetName()) {
        warn('undo snapshot belongs to preset', undo.preset);
        return false;
    }
    const s = liveSettings();
    s.prompts = structuredClone(undo.prompts);
    s.prompt_order = structuredClone(undo.prompt_order);
    clearUndo();
    saveLive();
    await rerender();
    return true;
}

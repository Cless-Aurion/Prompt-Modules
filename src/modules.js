/**
 * The module model.
 *
 * A header prompt opens a positional SPAN that runs until the next header, but
 * sitting in a span does not make a prompt a member. Membership is OPT-IN: a
 * prompt joins by being dragged in, toggled in from its row, or adopted with the
 * whole module. Prompts in the span that have not joined are `candidates` — they
 * stay fully visible when the module collapses.
 *
 * Two rules keep stored data honest:
 *   - an assignment only counts while the prompt is still inside that header's
 *     span, so metadata can never contradict what is on screen;
 *   - nothing about modules is written until you actually put something in one.
 *
 * Display order and enabled state come from prompt_order; content comes from the
 * prompts array (whose own order is irrelevant to both generation and the UI).
 */

import { orderCharacterId, settings as liveSettings } from './compat.js';
import { getSettings, getMemberships } from './settings.js';
import { GLOBAL_DUMMY_ID } from './constants.js';

let orderCid = GLOBAL_DUMMY_ID;

/** Resolve the live prompt_order character id once at startup. */
export async function initModel() {
    orderCid = await orderCharacterId();
    return orderCid;
}

export function getOrderCharacterId() {
    return orderCid;
}

/**
 * The live prompt_order entry list.
 *
 * Real presets can contain a stale `character_id: 100000` list alongside the live
 * `100001` one, so this resolves by id and never by array index.
 * @returns {Array<{identifier:string, enabled:boolean}>}
 */
export function getOrderList(s = liveSettings()) {
    const lists = Array.isArray(s?.prompt_order) ? s.prompt_order : [];
    const list = lists.find(l => String(l?.character_id) === String(orderCid));
    return Array.isArray(list?.order) ? list.order : [];
}

/**
 * Is this one of SillyTavern's own structural prompts rather than one of yours?
 *
 * Markers (chatHistory, worldInfoBefore/After, dialogueExamples …) and prompts
 * flagged `system_prompt` are load-bearing: generation depends on several of them
 * and SillyTavern restricts what may be done to them. They are excluded from bulk
 * actions like "add everything below to this module" so a single click can never
 * sweep them up, but nothing stops you adding one deliberately with its own row
 * toggle.
 */
export function isCorePrompt(prompt) {
    return Boolean(prompt?.marker) || Boolean(prompt?.system_prompt);
}

/** Is this prompt a module header? */
export function isHeaderPrompt(prompt) {
    if (!prompt || typeof prompt.name !== 'string') return false;
    const opts = getSettings();
    const chars = opts.headerChars || '';
    if (chars && [...chars].some(ch => prompt.name.includes(ch))) return true;
    if (opts.treatEmptyAsHeader && !String(prompt.content ?? '').trim()) return true;
    return false;
}

/**
 * Portable identity for a module or member name.
 *
 * Header names carry heavy decoration ("━━━━━(๑•᎑•マ Pace"), so this strips the
 * decoration down to the readable label. Used only as the LAST-RESORT matcher —
 * stored keys and prompt identifiers are tried first, and the user always sees
 * what matched before anything is applied.
 */
export function normalizeName(name) {
    const raw = String(name ?? '');
    const opts = getSettings();
    let stripped = raw;
    for (const ch of opts.headerChars || '') {
        stripped = stripped.split(ch).join(' ');
    }
    // Preferred: readable ASCII label, which discards kaomoji and emoji cleanly.
    let out = stripped.replace(/[^A-Za-z0-9 &:_/+.\-]/g, ' ');
    out = tidy(out);
    if (out) return out;
    // Fallback for names with no ASCII at all: keep any letters/digits.
    out = tidy(stripped.replace(/[^\p{L}\p{N} ]/gu, ' '));
    return out;
}

function tidy(value) {
    return value
        .replace(/\s+/g, ' ')
        .replace(/^[^\p{L}\p{N}]+/u, '')
        .replace(/[^\p{L}\p{N}]+$/u, '')
        .trim()
        .toLowerCase();
}

/**
 * Build the current module model from live settings.
 *
 * @returns {{
 *   orderList: Array<{identifier:string, enabled:boolean}>,
 *   byId: Map<string, any>,
 *   modules: Array<{id:string, header:any, headerEntry:any, headerIndex:number, normalized:string, members:Array<{prompt:any, entry:any, index:number}>}>,
 *   unassigned: Array<{prompt:any, entry:any, index:number}>,
 * }}
 */
function walk(orderList, byId, assignments, ignoreIdentifier = null) {
    const modules = [];
    const unassigned = [];
    const stale = [];
    let current = null;
    let run = false;

    orderList.forEach((entry, index) => {
        if (!entry) return;
        const prompt = byId.get(entry.identifier);
        // Order entries with no matching prompt are core's problem, not ours: skip.
        if (!prompt) return;
        // The ignored prompt is treated as absent: it neither joins a run nor
        // breaks one. That is what lets a drop be judged against the module as it
        // stands, rather than against a module the drop has just split in half.
        if (ignoreIdentifier && prompt.identifier === ignoreIdentifier) return;

        if (isHeaderPrompt(prompt)) {
            current = {
                id: prompt.identifier,
                header: prompt,
                headerEntry: entry,
                headerIndex: index,
                normalized: normalizeName(prompt.name),
                members: [],
                /** Prompts sitting in this module's span that have NOT joined it. */
                candidates: [],
            };
            modules.push(current);
            run = true;
            return;
        }

        const item = { prompt, entry, index, module: current };
        // A module is a CONTIGUOUS unit: its members are the unbroken run directly
        // under the header. The first prompt that is not a member ends the run,
        // and anything below that is outside the module even if it still carries an
        // assignment — otherwise you get members with strangers wedged between
        // them, which is not a module in any useful sense.
        if (current && run && assignments[prompt.identifier] === current.id) {
            current.members.push(item);
        } else {
            if (current) {
                run = false;
                current.candidates.push(item);
                // A mark below the break is stale; report it so it can be cleaned.
                if (assignments[prompt.identifier] === current.id) stale.push(prompt.identifier);
            }
            unassigned.push(item);
        }
    });

    return { modules, unassigned, stale };
}

/**
 * Build the current module model from live settings.
 */
export function deriveModel() {
    const s = liveSettings();
    const prompts = Array.isArray(s?.prompts) ? s.prompts.filter(Boolean) : [];
    const byId = new Map(prompts.map(p => [p.identifier, p]));
    const orderList = getOrderList(s);
    const assignments = getMemberships();
    return { orderList, byId, assignments, ...walk(orderList, byId, assignments) };
}

/** Find a module by the identifier of its header prompt. */
export function findModuleByHeaderId(model, headerIdentifier) {
    return model.modules.find(g => g.id === headerIdentifier) ?? null;
}

/** Find a module whose normalized header name matches. */
export function findModuleByName(model, normalized) {
    if (!normalized) return null;
    return model.modules.find(g => g.normalized === normalized) ?? null;
}

/**
 * Index range [start, end) the module occupies in prompt_order.
 *
 * This is the POSITIONAL span (header until the next header), which includes
 * prompts that have not joined the module — they still live inside it visually.
 */
export function moduleRange(module) {
    const start = module.headerIndex;
    const last = Math.max(
        module.members.length ? module.members[module.members.length - 1].index : start,
        module.candidates.length ? module.candidates[module.candidates.length - 1].index : start,
    );
    return { start, end: last + 1 };
}

/**
 * The module whose span a prompt currently sits in, member or not.
 * @returns {object|null}
 */
export function containingModule(model, identifier) {
    for (const module of model.modules) {
        if (module.members.some(m => m.prompt.identifier === identifier)) return module;
        if (module.candidates.some(c => c.prompt.identifier === identifier)) return module;
    }
    return null;
}

/**
 * Reconcile membership after a drag, keeping every module a contiguous unit.
 *
 * The dropped prompt is judged against the module AS IT STANDS — it is excluded
 * from the walk, so landing in the middle of a module cannot "break" that module
 * and strand everything below it. Dropping inside the block (directly under the
 * header, or in among the members) joins; dropping past the last member is
 * dropping below the module, which leaves. That is what gives the next header's
 * half-way point its meaning.
 *
 * Only once the drop is resolved is staleness recomputed, from the state that
 * will actually exist. Doing it the other way round meant a prompt dropped at the
 * top of a module evicted every real member underneath it.
 *
 * @returns {{assign: Array<[string,string]>, remove: string[]}|null} null if nothing changes.
 */
export function reconcileAfterDrop(promptIdentifier) {
    const s = liveSettings();
    const prompts = Array.isArray(s?.prompts) ? s.prompts.filter(Boolean) : [];
    const byId = new Map(prompts.map(p => [p.identifier, p]));
    const orderList = getOrderList(s);
    const assignments = getMemberships();
    if (!promptIdentifier) return null;

    // The list as if the dragged prompt were not there: each module's real block.
    const without = walk(orderList, byId, assignments, promptIdentifier);
    const at = orderList.findIndex(e => e?.identifier === promptIdentifier);
    if (at < 0) return null;

    // The module whose span it landed in — the last header above it.
    let landed = null;
    for (const module of without.modules) {
        if (module.headerIndex < at) landed = module;
        else break;
    }

    const hypothetical = { ...assignments };
    if (landed) {
        const block = landed.members;
        const blockEnd = block.length ? block[block.length - 1].index : landed.headerIndex;
        const inside = at === landed.headerIndex + 1 || at <= blockEnd;
        if (inside) hypothetical[promptIdentifier] = landed.id;
        else delete hypothetical[promptIdentifier];
    } else {
        delete hypothetical[promptIdentifier];
    }

    // Now that the drop is settled, find marks that are genuinely stranded.
    const after = walk(orderList, byId, hypothetical, null);
    for (const id of after.stale) delete hypothetical[id];

    const assign = [];
    const remove = [];
    for (const id of new Set([...Object.keys(assignments), ...Object.keys(hypothetical)])) {
        if (hypothetical[id] !== assignments[id]) {
            if (hypothetical[id]) assign.push([id, hypothetical[id]]);
            else remove.push(id);
        }
    }
    if (!assign.length && !remove.length) return null;
    return { assign, remove };
}

/**
 * Move a prompt to the nearest EDGE of a module it has just left.
 *
 * It only moves when it would otherwise sit among the module's remaining members;
 * a prompt already at the module's edge simply stays put. The destination is just
 * above the header or just past the last member — the module's own boundary, not
 * the next module's territory.
 *
 * @returns {boolean} Whether anything moved.
 */
export function ejectToModuleEdge(promptIdentifier, headerIdentifier) {
    const orderList = getOrderList();
    const module = deriveModel().modules.find(g => g.id === headerIdentifier);
    if (!module) return false;

    const at = orderList.findIndex(e => e?.identifier === promptIdentifier);
    const headerIdx = orderList.findIndex(e => e?.identifier === headerIdentifier);
    if (at < 0 || headerIdx < 0 || at <= headerIdx) return false;

    const members = module.members.filter(m => m.prompt.identifier !== promptIdentifier);
    if (!members.length) return false;
    const lastMemberIdx = members[members.length - 1].index;
    // Nothing of the module sits below it, so leaving it exactly here is correct.
    if (at > lastMemberIdx) return false;

    const [entry] = orderList.splice(at, 1);
    const distanceUp = at - headerIdx;
    const distanceDown = lastMemberIdx - at;
    if (distanceUp <= distanceDown) {
        orderList.splice(orderList.findIndex(e => e?.identifier === headerIdentifier), 0, entry);
    } else {
        const last = members[members.length - 1].prompt.identifier;
        orderList.splice(orderList.findIndex(e => e?.identifier === last) + 1, 0, entry);
    }
    return true;
}

/**
 * Move a prompt so it sits at the end of a module's span. Joining still requires
 * an explicit membership write — this only handles the position.
 */
export function movePromptToModuleEnd(identifier, headerIdentifier) {
    const orderList = getOrderList();
    const module = deriveModel().modules.find(g => g.id === headerIdentifier);
    if (!module || identifier === headerIdentifier) return false;

    const from = orderList.findIndex(e => e?.identifier === identifier);
    if (from < 0) return false;
    const [entry] = orderList.splice(from, 1);

    // Recompute after the removal so the insertion index is still correct.
    const after = deriveModel().modules.find(g => g.id === headerIdentifier);
    const end = after ? moduleRange(after).end : orderList.length;
    orderList.splice(end, 0, entry);
    return true;
}

/** Identifiers belonging to a module, header first. */
export function moduleIdentifiers(module) {
    return [module.id, ...module.members.map(m => m.prompt.identifier)];
}

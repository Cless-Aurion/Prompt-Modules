/**
 * Feature 1 — collapsible modules.
 *
 * Hard rules derived from SillyTavern 1.18.0's sortable integration
 * (PromptManager.js:1918-1937), all verified:
 *
 *  1. Collapse by HIDING rows in place. Never detach a row and never re-parent
 *     prompt rows under a wrapper: the sortable `update` handler rebuilds
 *     prompt_order from `sortable('toArray')`, so a row missing from the list is
 *     silently deleted from prompt_order and nothing restores it.
 *  2. Never add `completion_prompt_manager_prompt_draggable` to anything we
 *     inject, and never remove it from a real row — same reason.
 *  3. Re-apply after every render: the prompt manager wipes its container with
 *     `innerHTML = ''` and emits no events at all.
 */

import { CONTAINER_ID, LIST_ID, ID_ATTR, CLS } from './constants.js';
import { settings as liveSettings, saveLive, rerender } from './compat.js';
import {
    deriveModel, getOrderList, containingModule, reconcileAfterDrop, ejectToModuleEdge,
} from './modules.js';
import { getSettings, isCollapsed, setCollapsed, setAllCollapsed, updateMemberships } from './settings.js';
import { debug, warn } from './log.js';

let observer = null;
let scheduled = false;
let decorating = false;
let burstStart = 0;
let burstCount = 0;
/** Module membership captured when a drag starts, so we can move a whole module. */
let dragSnapshot = null;
let onModuleMenu = () => {};

/** Register the callback invoked when a header's "⋯" action is clicked. */
export function setModuleMenuHandler(fn) {
    onModuleMenu = fn;
}

function rowFor(list, identifier) {
    return list.querySelector(`li[${ID_ATTR}="${window.CSS.escape(identifier)}"]`);
}

/* ------------------------------- decoration ------------------------------ */

/** Full reset, including the member toggle. Used when disabling or unloading. */
function clearDecoration(row) {
    clearHeaderArtifacts(row);
    row.querySelector(`.${CLS.memberToggle}`)?.remove();
}

/**
 * Remove header-only decoration. Deliberately leaves the member toggle alone:
 * that element belongs on ordinary rows, and removing then re-adding it on every
 * pass would be a childList mutation each time — i.e. the decorate feedback loop
 * all over again. Elements are removed only when actually present, so a
 * already-clean row produces no mutations at all.
 */
function clearHeaderArtifacts(row) {
    row.classList.remove(CLS.header, CLS.decorated, CLS.hidden, CLS.unassigned);
    row.removeAttribute(CLS.memberAttr);
    row.querySelectorAll(`.${CLS.toggle}, .${CLS.badge}, .${CLS.actions}`).forEach(el => el.remove());
}

function decorateHeader(row, module) {
    const nameSpan = row.querySelector('.completion_prompt_manager_prompt_name');
    if (!nameSpan) return;

    row.classList.add(CLS.header, CLS.decorated);

    let toggle = row.querySelector(`.${CLS.toggle}`);
    if (!toggle) {
        toggle = document.createElement('span');
        toggle.className = `${CLS.toggle} fa-solid fa-fw`;
        toggle.setAttribute('role', 'button');
        toggle.setAttribute('tabindex', '0');
        const activate = event => {
            event.preventDefault();
            event.stopPropagation();
            // Shift applies the same direction to every module, so one click can
            // fold the whole list without going to the settings panel.
            if (event.shiftKey) setAll(!isCollapsed(module.id));
            else toggleModule(module.id);
        };
        toggle.addEventListener('click', activate);
        toggle.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') activate(event);
        });
        nameSpan.insertBefore(toggle, nameSpan.firstChild);
    }

    const collapsed = isCollapsed(module.id);
    toggle.classList.toggle('fa-chevron-right', collapsed);
    toggle.classList.toggle('fa-chevron-down', !collapsed);
    toggle.title = collapsed ? 'Expand module' : 'Collapse module';

    const opts = getSettings();
    let badge = row.querySelector(`.${CLS.badge}`);
    if (opts.showCounts) {
        if (!badge) {
            badge = document.createElement('small');
            badge.className = CLS.badge;
            nameSpan.appendChild(badge);
        }
        const total = module.members.length;
        const on = module.members.filter(m => m.entry?.enabled).length;
        const text = total ? `${on}/${total}` : 'empty';
        // Assign ONLY on change. Writing textContent replaces the element's child
        // text node, which is a childList mutation our own observer picks up — an
        // unconditional write here is a self-feeding decorate loop. That loop was
        // the real cause of modules flickering on every prompt toggle.
        if (badge.textContent !== text) badge.textContent = text;
        badge.title = `${total} prompt(s) in this module, ${on} enabled`;
    } else if (badge) {
        badge.remove();
    }

    // Attribute-only hint on SillyTavern's own switch, so the shortcut is findable.
    const coreToggle = row.querySelector('.prompt-manager-toggle-action');
    if (coreToggle) coreToggle.title = 'Shift+click to switch this whole module on or off';

    let actions = row.querySelector(`.${CLS.actions}`);
    if (!actions) {
        actions = document.createElement('span');
        actions.className = `${CLS.actions} fa-solid fa-ellipsis-vertical`;
        actions.title = 'Module actions';
        actions.setAttribute('role', 'button');
        actions.setAttribute('tabindex', '0');
        actions.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            onModuleMenu(module.id);
        });
        nameSpan.appendChild(actions);
    }
}

/**
 * The in/out control on a prompt row. Only rows that sit inside some module's span
 * get one — elsewhere there is no module to join.
 */
function decorateMemberToggle(row, module, isMember) {
    const nameSpan = row.querySelector('.completion_prompt_manager_prompt_name');
    if (!nameSpan) return;

    let toggle = row.querySelector(`.${CLS.memberToggle}`);
    if (!toggle) {
        toggle = document.createElement('span');
        toggle.className = CLS.memberToggle;
        toggle.setAttribute('role', 'button');
        toggle.setAttribute('tabindex', '0');
        toggle.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            const promptId = row.getAttribute(ID_ATTR);
            const headerId = toggle.dataset.pgModule;
            const joining = toggle.dataset.pgMember !== '1';
            if (!promptId || !headerId) return;

            // Order matters when leaving: move the prompt to the module's edge
            // while it is STILL a member, then drop the membership. Doing it the
            // other way round breaks the run at this prompt, which would strand
            // every member below it and dissolve the rest of the module.
            const moved = !joining && ejectToModuleEdge(promptId, headerId);
            await updateMemberships(
                joining ? [[promptId, headerId]] : [],
                joining ? [] : [promptId],
            );
            if (moved) {
                saveLive();
                await rerender();
                return;
            }
            decorateNow();
        });
        nameSpan.appendChild(toggle);
    }

    // Attribute-only updates: these do not disturb the MutationObserver, which
    // watches childList exclusively.
    toggle.dataset.pgModule = module.id;
    toggle.dataset.pgMember = isMember ? '1' : '0';
    toggle.className = `${CLS.memberToggle} fa-solid fa-fw ${isMember ? 'fa-link' : 'fa-link-slash'}`;
    const label = String(module.header.name ?? '').replace(/━/g, '').trim() || 'this module';
    toggle.title = isMember
        ? `In "${label}" — click to take it out`
        : `Not in "${label}" — click to add it`;
}

/** Idempotently apply all module decoration to the current DOM. */
export function decorate() {
    const opts = getSettings();
    const list = document.getElementById(LIST_ID);
    if (!list) return;

    const rows = Array.from(list.querySelectorAll(`li[${ID_ATTR}]`));
    if (!rows.length) return;

    if (!opts.enabled) {
        rows.forEach(clearDecoration);
        return;
    }

    const model = deriveModel();
    const headerIds = new Set(model.modules.map(g => g.id));

    // Reset per-row state so a row that stopped being a header/member is clean.
    for (const row of rows) {
        const id = row.getAttribute(ID_ATTR);
        row.classList.remove(CLS.hidden, CLS.unassigned);
        row.removeAttribute(CLS.memberAttr);
        if (!headerIds.has(id)) clearHeaderArtifacts(row);
    }

    const rowsWithToggle = new Set();

    for (const module of model.modules) {
        const headerRow = rowFor(list, module.id);
        if (headerRow) decorateHeader(headerRow, module);

        const collapsed = isCollapsed(module.id);
        for (const member of module.members) {
            const memberRow = rowFor(list, member.prompt.identifier);
            if (!memberRow) continue;
            memberRow.setAttribute(CLS.memberAttr, module.id);
            memberRow.classList.toggle(CLS.hidden, collapsed);
            decorateMemberToggle(memberRow, module, true);
            rowsWithToggle.add(member.prompt.identifier);
        }
        // Prompts sitting in the span that have not joined. They stay visible when
        // the module collapses, and offer a one-click way in.
        for (const candidate of module.candidates) {
            const row = rowFor(list, candidate.prompt.identifier);
            if (!row) continue;
            row.classList.add(CLS.unassigned);
            decorateMemberToggle(row, module, false);
            rowsWithToggle.add(candidate.prompt.identifier);
        }
    }

    // Rows outside every span (above the first header) have no module to join.
    for (const row of rows) {
        if (!rowsWithToggle.has(row.getAttribute(ID_ATTR))) {
            row.querySelector(`.${CLS.memberToggle}`)?.remove();
        }
    }

    bindDragGuards(list);
}

/* --------------------------------- toggle -------------------------------- */

/** Decorate immediately (used after a user action, so it lands in this frame). */
export function decorateNow() {
    if (decorating) return;
    decorating = true;
    try {
        decorate();
    } catch (err) {
        warn('decoration failed', err);
    } finally {
        decorating = false;
    }
}

export function toggleModule(headerIdentifier) {
    setCollapsed(headerIdentifier, !isCollapsed(headerIdentifier));
    decorateNow();
}

export function setAll(collapsed) {
    const ids = deriveModel().modules.map(g => g.id);
    setAllCollapsed(ids, collapsed);
    decorateNow();
}

/* ------------------------------- drag guards ------------------------------ */

/**
 * A drag moves only the dragged <li>. Dragging a collapsed header would leave its
 * hidden members behind and persist a split module, so capture membership on drag
 * start and restore contiguity afterwards.
 */
function bindDragGuards(list) {
    if (list.dataset.pgDragBound === '1') return;
    const $list = globalThis.jQuery ? globalThis.jQuery(list) : null;
    if (!$list) return;

    $list.on('sortstart', (_event, ui) => {
        try {
            const model = deriveModel();
            const draggedId = ui?.item?.attr?.(ID_ATTR) ?? null;
            const module = model.modules.find(g => g.id === draggedId);
            dragSnapshot = module
                ? {
                    // A header carries its members whether the module is open or
                    // shut — otherwise moving a module means dragging every row.
                    kind: 'header',
                    headerId: module.id,
                    memberIds: module.members.map(m => m.prompt.identifier),
                }
                : {
                    kind: 'prompt',
                    promptId: draggedId,
                    fromModuleId: containingModule(model, draggedId)?.id ?? null,
                };
        } catch (err) {
            warn('sortstart snapshot failed', err);
            dragSnapshot = null;
        }
    });

    $list.on('sortupdate', () => {
        const snapshot = dragSnapshot;
        dragSnapshot = null;
        if (!snapshot) return;
        // Defer so SillyTavern's own `update` handler has written prompt_order first,
        // whichever order the two handlers happen to run in.
        setTimeout(async () => {
            if (snapshot.kind === 'header') {
                if (!getSettings().moveModuleOnDrag) return;
                if (repairModuleContiguity(snapshot)) {
                    saveLive();
                    await rerender();
                }
                return;
            }
            await applyDropMembership(snapshot);
        }, 0);
    });

    list.dataset.pgDragBound = '1';
}

/**
 * Apply the membership consequences of a drop, and keep every module contiguous.
 */
async function applyDropMembership({ promptId }) {
    const outcome = reconcileAfterDrop(promptId);
    if (!outcome) return;
    if (await updateMemberships(outcome.assign, outcome.remove)) decorateNow();
}

/** Move a collapsed module's members back to directly follow their header. */
function repairModuleContiguity({ headerId, memberIds }) {
    if (!memberIds?.length) return false;
    const orderList = getOrderList(liveSettings());
    if (!orderList.length) return false;

    const wanted = new Set(memberIds);
    const pulled = [];
    for (let i = orderList.length - 1; i >= 0; i--) {
        const entry = orderList[i];
        if (entry && entry.identifier !== headerId && wanted.has(entry.identifier)) {
            pulled.unshift(orderList.splice(i, 1)[0]);
        }
    }
    if (!pulled.length) return false;

    const headerIndex = orderList.findIndex(e => e?.identifier === headerId);
    if (headerIndex < 0) {
        // Header vanished (shouldn't happen) — put the members back where they were.
        orderList.push(...pulled);
        return true;
    }

    pulled.sort((a, b) => memberIds.indexOf(a.identifier) - memberIds.indexOf(b.identifier));
    orderList.splice(headerIndex + 1, 0, ...pulled);
    debug(`moved ${pulled.length} member(s) with collapsed module ${headerId}`);
    return true;
}

/* -------------------------------- observer ------------------------------- */

/**
 * Debounced re-decoration.
 *
 * Deliberately does NOT disconnect the observer while decorating:
 * `MutationObserver.disconnect()` throws away the pending record queue, so any
 * DOM change the prompt manager made between the callback and this frame would
 * be lost — and since its render is async and multi-step, that reliably drops the
 * batch that actually inserts the rows.
 *
 * A loop cannot happen instead because we observe `childList` only (not
 * attributes), and decoration is idempotent: on a second pass every chevron,
 * badge and action button already exists, so no child nodes are added and no
 * further records are produced.
 */
export function apply() {
    if (scheduled) return;
    scheduled = true;
    // setTimeout, not requestAnimationFrame: frames are starved while the tab or
    // panel is not being painted, which would latch `scheduled` on forever and
    // silently stop every future re-decoration. Timers still fire when hidden.
    setTimeout(() => {
        scheduled = false;
        try {
            observeContainer();
            decorate();
        } catch (err) {
            warn('decoration failed', err);
        }
    }, 0);
}

let observedContainer = null;

function observeContainer() {
    const container = document.getElementById(CONTAINER_ID);
    if (!container || !observer) return;
    // Re-attach if the container node itself was ever swapped out from under us.
    if (observedContainer === container) return;
    observer.disconnect();
    observer.observe(container, { childList: true, subtree: true });
    observedContainer = container;
}

/**
 * The prompt manager emits no events, so DOM observation is the only way to know
 * it re-rendered. `#completion_prompt_manager` is the one node that survives.
 */
export function startObserving() {
    if (observer) return;
    // Decorate SYNCHRONOUSLY inside the observer callback. MutationObserver
    // callbacks run as microtasks, i.e. before the browser paints, so the
    // rebuilt list is styled and collapsed in the same frame it appears in.
    // Deferring this (setTimeout/rAF) lets an undecorated frame paint first,
    // which is what made every module flicker whenever a prompt was toggled.
    //
    // `decorating` only guards against re-entering the same synchronous pass;
    // the records our own edits produce still arrive as a normal follow-up
    // callback, which is a no-op because decoration is idempotent.
    observer = new MutationObserver(() => {
        if (decorating) return;
        // Circuit breaker. Decoration is written to be idempotent, but if a future
        // change ever makes it mutate unconditionally, the synchronous observer
        // would spin forever and lock the tab. Bail out loudly instead.
        const now = performance.now();
        if (now - burstStart > 1000) {
            burstStart = now;
            burstCount = 0;
        }
        if (++burstCount > 60) {
            warn('decoration is re-triggering itself; pausing the observer for this render');
            return;
        }
        decorating = true;
        try {
            decorate();
        } catch (err) {
            warn('decoration failed', err);
        } finally {
            decorating = false;
        }
    });
    observeContainer();
    apply();
}

export function stopObserving() {
    observer?.disconnect();
    observer = null;
    observedContainer = null;
    const list = document.getElementById(LIST_ID);
    if (list) {
        list.querySelectorAll(`li[${ID_ATTR}]`).forEach(clearDecoration);
        delete list.dataset.pgDragBound;
    }
}

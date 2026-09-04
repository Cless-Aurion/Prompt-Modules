/**
 * All user-facing surfaces: the per-module menu, the import preview, and the
 * settings panel in the Extensions drawer.
 *
 * The module menu is a small self-positioned floating menu (the pattern core's
 * Quick Persona extension uses) rather than a popup, so it feels like part of the
 * prompt list.
 */

import { MODULE_NAME, CLS, ID_ATTR, LIST_ID } from './constants.js';
import { ctx, toast, currentPresetName, saveLive, rerender } from './compat.js';
import { deriveModel, findModuleByHeaderId, normalizeName, isCorePrompt } from './modules.js';
import {
    getSettings, save, isCollapsed, getLibrary, putLibraryEntry, deleteLibraryEntry, updateMemberships,
} from './settings.js';
import { apply, toggleModule, setAll, decorateNow } from './collapse.js';
import {
    buildModulePayload, validatePayload, buildDiff, applyDiff, canUndo, undoLast, deleteModule,
} from './transfer.js';
import { warn } from './log.js';

let menuElement = null;

/* ------------------------------- utilities ------------------------------- */

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
}

function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 4)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function pickJsonFile() {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.style.display = 'none';
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            input.remove();
            if (!file) return resolve(null);
            try {
                resolve(JSON.parse(await file.text()));
            } catch (err) {
                warn('could not parse file', err);
                toast()?.error('That file is not valid JSON.');
                resolve(null);
            }
        });
        document.body.appendChild(input);
        input.click();
    });
}

function safeFilename(value) {
    return String(value ?? 'module').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'module';
}

/* ------------------------------- module menu ------------------------------ */

export function closeModuleMenu() {
    menuElement?.remove();
    menuElement = null;
    document.removeEventListener('click', onDocumentClick, true);
}

function onDocumentClick(event) {
    if (menuElement && !menuElement.contains(event.target)) closeModuleMenu();
}

export function openModuleMenu(headerIdentifier) {
    closeModuleMenu();

    const model = deriveModel();
    const module = findModuleByHeaderId(model, headerIdentifier);
    if (!module) return;

    const anchor = document.querySelector(
        `li[data-pm-identifier="${window.CSS.escape(headerIdentifier)}"] .${CLS.actions}`,
    );
    if (!anchor) return;

    const collapsed = isCollapsed(headerIdentifier);
    const library = getLibrary();
    const libraryEntries = Object.entries(library);

    const items = [
        { icon: collapsed ? 'fa-chevron-down' : 'fa-chevron-right', label: collapsed ? 'Expand' : 'Collapse', action: () => toggleModule(headerIdentifier) },
        { icon: 'fa-angles-up', label: 'Collapse all modules', action: () => setAll(true) },
        { icon: 'fa-angles-down', label: 'Expand all modules', action: () => setAll(false) },
        { separator: true },
    ];

    // Membership is opt-in, so a module starts empty. Adopting is the one-click way
    // to take in everything already sitting under the header.
    const span = [...module.members, ...module.candidates].sort((a, b) => a.index - b.index);
    const runnable = [];
    for (const item of span) {
        if (isCorePrompt(item.prompt)) break;
        runnable.push(item);
    }
    const adoptable = runnable.filter(item => !module.members.includes(item));
    const skipped = span.length - runnable.length;
    if (adoptable.length) {
        items.push({
            icon: 'fa-square-plus',
            label: `Add the ${adoptable.length} prompt(s) below to this module`,
            title: skipped
                ? `${skipped} of SillyTavern's own prompts below this header are left out. Add one deliberately with its row toggle if you want it in.`
                : '',
            action: () => adoptModule(headerIdentifier),
        });
    }
    if (module.members.length) {
        items.push({
            icon: 'fa-square-minus',
            label: `Take all ${module.members.length} prompt(s) out of this module`,
            action: () => releaseModule(headerIdentifier),
        });
    }

    items.push(
        { separator: true },
        { icon: 'fa-box-archive', label: 'Save module to library', action: () => saveModuleToLibrary(headerIdentifier) },
        { icon: 'fa-file-export', label: 'Export module to file', action: () => exportModuleToFile(headerIdentifier) },
        { separator: true },
        { icon: 'fa-file-import', label: 'Update this module from file…', action: () => importFromFile() },
    );

    if (libraryEntries.length) {
        items.push({
            icon: 'fa-boxes-stacked',
            label: `Update from library… (${libraryEntries.length})`,
            action: () => showLibraryPicker(),
        });
    }

    menuElement = document.createElement('div');
    menuElement.className = 'pm-menu';
    for (const item of items) {
        if (item.separator) {
            const hr = document.createElement('div');
            hr.className = 'pm-menu-separator';
            menuElement.appendChild(hr);
            continue;
        }
        const row = document.createElement('div');
        row.className = 'pm-menu-item';
        if (item.title) row.title = item.title;
        row.innerHTML = `<span class="fa-fw fa-solid ${item.icon}"></span><span></span>`;
        row.lastElementChild.textContent = item.label;
        row.addEventListener('click', () => {
            closeModuleMenu();
            try {
                item.action();
            } catch (err) {
                warn('menu action failed', err);
                toast()?.error(String(err?.message ?? err));
            }
        });
        menuElement.appendChild(row);
    }

    // Mount INSIDE the open drawer, not on <body>. SillyTavern auto-closes any
    // unpinned drawer when a click's target has no `.openDrawer` ancestor
    // (script.js:12120), so a body-mounted menu made the whole panel vanish the
    // moment you picked an item. The menu is position:fixed, so nesting it here
    // costs nothing visually.
    const host = anchor.closest('.openDrawer') ?? anchor.closest('.drawer-content') ?? document.body;
    host.appendChild(menuElement);
    const rect = anchor.getBoundingClientRect();
    const menuRect = menuElement.getBoundingClientRect();
    const top = Math.min(rect.bottom + 4, window.innerHeight - menuRect.height - 8);
    const left = Math.min(rect.left, window.innerWidth - menuRect.width - 8);
    menuElement.style.top = `${Math.max(8, top)}px`;
    menuElement.style.left = `${Math.max(8, left)}px`;

    setTimeout(() => document.addEventListener('click', onDocumentClick, true), 0);
}

/* ------------------------------- membership ------------------------------- */

/**
 * Take in the prompts already sitting under this header — yours, not
 * SillyTavern's. Its own structural prompts are skipped so one click cannot
 * sweep World Info or Chat History into a module; add those deliberately instead.
 */
export async function adoptModule(headerIdentifier) {
    const module = findModuleByHeaderId(deriveModel(), headerIdentifier);
    if (!module) return;

    // Walk the span from the header and stop at the first of SillyTavern's own
    // prompts. Taking the ones past it would leave them cut off from the header by
    // a non-member, and a module is a contiguous run — they would be inert anyway.
    const span = [...module.members, ...module.candidates].sort((a, b) => a.index - b.index);
    const adoptable = [];
    for (const item of span) {
        if (isCorePrompt(item.prompt)) break;
        adoptable.push(item);
    }
    if (!adoptable.length) return;
    const skipped = span.length - adoptable.length;
    await updateMemberships(adoptable.map(c => [c.prompt.identifier, headerIdentifier]), []);
    decorateNow();
    toast()?.success(
        `Added ${adoptable.length} prompt(s)` + (skipped ? `, left ${skipped} SillyTavern prompt(s) alone` : ''),
    );
}

/** Empty a module without moving or changing any prompt. */
export async function releaseModule(headerIdentifier) {
    const module = findModuleByHeaderId(deriveModel(), headerIdentifier);
    if (!module?.members.length) return;
    const count = module.members.length;
    await updateMemberships([], module.members.map(m => m.prompt.identifier));
    decorateNow();
    toast()?.info(`Took ${count} prompt(s) out of the module`);
}

/* --------------------- switch a whole module on or off --------------------- */

/**
 * Shift+click a header's on/off switch to flip every prompt in the module.
 *
 * The header's own switch is left alone: headers are usually kept on as visual
 * anchors, and an empty header costs nothing either way.
 */
export function mountModuleToggleInterceptor() {
    document.addEventListener('click', event => {
        if (!event.shiftKey) return;
        const icon = event.target?.closest?.('.prompt-manager-toggle-action');
        if (!icon) return;
        const row = icon.closest(`li[${ID_ATTR}]`);
        const headerId = row?.getAttribute(ID_ATTR);
        if (!headerId) return;
        const module = findModuleByHeaderId(deriveModel(), headerId);
        if (!module?.members.length) return;

        event.preventDefault();
        event.stopPropagation();
        toggleModuleEnabled(headerId);
    }, true);
}

async function toggleModuleEnabled(headerIdentifier) {
    const module = findModuleByHeaderId(deriveModel(), headerIdentifier);
    if (!module) return;
    const list = document.getElementById(LIST_ID);

    // Respect SillyTavern's own rules about what may be switched: a member whose
    // row has no toggle control is one core refuses to toggle, so leave it be.
    const switchable = module.members.filter(member => {
        const memberRow = list?.querySelector(`li[${ID_ATTR}="${window.CSS.escape(member.prompt.identifier)}"]`);
        return Boolean(memberRow?.querySelector('.prompt-manager-toggle-action'));
    });
    if (!switchable.length) return;

    const turningOff = switchable.every(m => m.entry?.enabled);
    for (const member of switchable) {
        if (member.entry) member.entry.enabled = !turningOff;
    }

    const skipped = module.members.length - switchable.length;
    saveLive();
    await rerender();
    decorateNow();
    const label = String(module.header.name ?? '').replace(/━/g, '').trim() || 'module';
    toast()?.success(
        `${turningOff ? 'Switched off' : 'Switched on'} ${switchable.length} prompt(s)`
        + (skipped ? `, ${skipped} left alone` : ''),
        `Module "${label}"`,
    );
}

/* ------------------------------ delete a module ---------------------------- */

/**
 * On a header row, SillyTavern's red "Remove" chain would just de-list the header
 * and leave its prompts orphaned mid-list. Intercept it and offer to remove the
 * module properly instead. Ordinary rows are left entirely to SillyTavern.
 */
export function mountDeleteModuleInterceptor() {
    document.addEventListener('click', event => {
        const icon = event.target?.closest?.('.prompt-manager-detach-action');
        if (!icon) return;
        const row = icon.closest(`li[${ID_ATTR}]`);
        const headerId = row?.getAttribute(ID_ATTR);
        if (!headerId) return;
        if (!findModuleByHeaderId(deriveModel(), headerId)) return;   // not a header

        // Capture phase, so this runs before the handler core bound to the icon.
        event.preventDefault();
        event.stopPropagation();
        confirmDeleteModule(headerId);
    }, true);
}

async function confirmDeleteModule(headerIdentifier) {
    const module = findModuleByHeaderId(deriveModel(), headerIdentifier);
    if (!module) return;
    const label = String(module.header.name ?? '').replace(/━/g, '').trim() || 'this module';

    const count = module.members.length;
    const container = document.createElement('div');
    container.className = 'pm-dialog';
    container.innerHTML = `
        <h3 class="pm-dialog-title">Remove the module?</h3>
        <p>Module <b>${escapeHtml(label)}</b>${count ? ` with ${count} prompt(s) in it` : ''}.</p>
        <p>The header is removed from the list, and stays available in the
           <b>prompts dropdown</b> so you can put it back later.</p>
        <div class="pm-options">
            <label class="checkbox_label"><input type="checkbox" id="pm-del-remove">
                Remove the prompts inside the module too</label>
            <label class="checkbox_label"><input type="checkbox" id="pm-del-purge">
                Remove and <b class="pm-danger">delete</b> the prompts inside the module too</label>
        </div>
        <small class="pm-muted pm-footnote" id="pm-del-note"></small>`;

    const removeBox = container.querySelector('#pm-del-remove');
    const purgeBox = container.querySelector('#pm-del-purge');
    const note = container.querySelector('#pm-del-note');

    const sync = () => {
        // Deleting implies removing, so keep the weaker box ticked and locked.
        if (purgeBox.checked) {
            removeBox.checked = true;
            removeBox.disabled = true;
        } else {
            removeBox.disabled = false;
        }
        note.innerHTML = purgeBox.checked
            ? '<b class="pm-danger">The module and its prompts are erased permanently</b> — they will not be in the prompts dropdown. Undo last change can still bring them back this session. Prompts SillyTavern protects (system and marker prompts) are never touched.'
            : (removeBox.checked
                ? 'The header and its prompts are taken out of the list. Every one of them stays in the prompts dropdown. Prompts SillyTavern protects are left in place.'
                : 'Only the header is removed. Its prompts stay in the list, no longer in a module.');
    };
    removeBox.addEventListener('change', sync);
    purgeBox.addEventListener('change', sync);
    sync();

    const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const result = await callGenericPopup(container, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Yes', cancelButton: 'No', wide: false,
    });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;

    try {
        const stats = await deleteModule(headerIdentifier, {
            removeContents: removeBox.checked,
            deleteContents: purgeBox.checked,
        });
        if (!stats) return;
        decorateNow();
        renderSettingsPanel();
        const verb = stats.deleted ? 'Deleted' : 'Removed';
        const extra = stats.skipped ? `, ${stats.skipped} protected prompt(s) left alone` : '';
        toast()?.success(`${verb} ${stats.removed} prompt(s)${extra}`, `Module "${label}"`);
    } catch (err) {
        warn('module removal failed', err);
        toast()?.error(String(err?.message ?? err), 'Removal failed');
    }
}

/* --------------------------------- export -------------------------------- */

export async function exportModuleToFile(headerIdentifier) {
    const payload = await buildModulePayload(headerIdentifier);
    const label = normalizeName(payload.promptModules.module.name) || 'module';
    downloadJson(`promptmodule-${safeFilename(label)}.json`, payload);
    toast()?.success(`Exported "${payload.promptModules.module.name.trim()}"`);
}

export async function saveModuleToLibrary(headerIdentifier) {
    const payload = await buildModulePayload(headerIdentifier);
    const key = payload.promptModules.module.key;
    const existing = getLibrary()[key];
    putLibraryEntry(key, payload);
    toast()?.success(existing
        ? `Updated "${payload.promptModules.module.name.trim()}" in the library`
        : `Saved "${payload.promptModules.module.name.trim()}" to the library`);
    renderSettingsPanel();
}

/* --------------------------------- import -------------------------------- */

export async function importFromFile() {
    const payload = await pickJsonFile();
    if (!payload) return;
    await startImport(payload);
}

export async function importFromLibrary(key) {
    const payload = getLibrary()[key];
    if (!payload) return;
    await startImport(structuredClone(payload));
}

export async function startImport(payload) {
    const problem = validatePayload(payload);
    if (problem) {
        toast()?.error(problem);
        return;
    }
    const diff = buildDiff(payload);
    await showImportDialog(payload, diff);
}

function summaryRow(label, value, hint = '', tip = '') {
    return `<div class="pm-summary-row"${tip ? ` title="${escapeHtml(tip)}"` : ''}><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b>${hint ? `<small>${escapeHtml(hint)}</small>` : ''}</div>`;
}

/**
 * Never truncates. You are about to change prompts, so the list of what will be
 * touched has to be complete — the container scrolls instead.
 */
function listPrompts(items, mapper) {
    if (!items.length) return '<em class="pm-muted">none</em>';
    const shown = items.map(mapper).map(t => `<li>${escapeHtml(t)}</li>`).join('');
    return `<ul class="pm-list">${shown}</ul>`;
}

async function showImportDialog(payload, diff) {
    const pm = payload.promptModules;
    const name = String(pm.module.name ?? '').trim();
    const changed = diff.updates.filter(u => u.changed);
    const unchanged = diff.updates.length - changed.length;

    const container = document.createElement('div');
    container.className = 'pm-dialog';

    const header = diff.mode === 'create'
        ? `<p>Module <b>${escapeHtml(name)}</b> does not exist in <b>${escapeHtml(currentPresetName())}</b>. It will be added as a new module.</p>`
        : `<p>Updating <b>${escapeHtml(diff.target.header.name.trim())}</b> in <b>${escapeHtml(currentPresetName())}</b><br>
             <small class="pm-muted">matched by ${escapeHtml(diff.matchedBy)}</small></p>`;

    const TIP = {
        updated: 'Prompts that exist in both and whose content differs. Their text and settings will be replaced with the incoming version.',
        added: 'Prompts in the imported module that this preset does not have. They will be created and put in the module.',
        extras: 'Prompts that are in this preset’s module but not in the imported one. Left alone unless you tick the remove option below.',
    };
    const body = diff.mode === 'create'
        ? `${summaryRow('Prompts to add', String(diff.additions.length), '', TIP.added)}
           <div class="pm-block" title="${escapeHtml(TIP.added)}"><label>Will be added</label>${listPrompts(diff.additions, a => a.prompt.name)}</div>`
        : `${summaryRow('Will be updated', String(changed.length), unchanged ? `${unchanged} already identical` : '', TIP.updated)}
           ${summaryRow('Will be added', String(diff.additions.length), '', TIP.added)}
           ${summaryRow('Only in this preset', String(diff.extras.length), 'kept unless you tick "remove"', TIP.extras)}
           <div class="pm-block" title="${escapeHtml(TIP.updated)}"><label>Updated</label>${listPrompts(changed, u => u.target.prompt.name)}</div>
           <div class="pm-block" title="${escapeHtml(TIP.added)}"><label>Added</label>${listPrompts(diff.additions, a => a.prompt.name)}</div>
           <div class="pm-block" title="${escapeHtml(TIP.extras)}"><label>Only in this preset</label>${listPrompts(diff.extras, e => e.prompt.name)}</div>`;

    const options = diff.mode === 'create'
        ? `<label class="checkbox_label" title="Put the new module at the very top of the prompt list instead of the bottom. You can drag it anywhere afterwards.">
               <input type="checkbox" id="pm-opt-top"> Insert at the top of the list (default: bottom)</label>`
        : `<label class="checkbox_label" title="Replace the text and settings of prompts that exist in both, with the incoming version. Untick to add missing prompts without touching what you already have.">
               <input type="checkbox" id="pm-opt-update" checked> Update matched prompts</label>
           <label class="checkbox_label" title="Also update the header prompt itself. Headers can carry real content, so this is separate from updating the prompts inside.">
               <input type="checkbox" id="pm-opt-header" checked> Update the module header prompt itself</label>
           <label class="checkbox_label" title="Create the prompts that the imported module has and this preset does not, and put them in the module.">
               <input type="checkbox" id="pm-opt-add" checked> Add prompts that are missing here</label>
           <label class="checkbox_label" title="Rearrange the module so its prompts sit in the same order as the source. Prompts the source does not know about keep their relative order at the end.">
               <input type="checkbox" id="pm-opt-reorder" checked> Match the source's order</label>
           <label class="checkbox_label" title="Also copy which prompts are switched on or off. Off by default, because enabling and disabling prompts is usually tuning specific to this preset.">
               <input type="checkbox" id="pm-opt-enabled"> Also copy on/off states</label>
           <label class="checkbox_label pm-danger" title="Take prompts that exist only in this preset out of the list. They are NOT deleted — they stay available in the prompts dropdown. Off by default so an import can never lose your local additions.">
               <input type="checkbox" id="pm-opt-remove"> Remove prompts that exist only here</label>`;

    container.innerHTML = `
        <h3 class="pm-dialog-title">Import prompt module</h3>
        ${header}
        <div class="pm-summary">${body}</div>
        <hr class="sysHR">
        <div class="pm-options">${options}</div>
        <small class="pm-muted pm-footnote">Applies to the live preset. Use SillyTavern's <b>Update current preset</b> to write it to the preset file. Removed prompts are only taken out of the list — they stay available in the "insert prompt" dropdown.</small>
    `;

    const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const result = await callGenericPopup(container, POPUP_TYPE.CONFIRM, '', {
        okButton: diff.mode === 'create' ? 'Add module' : 'Apply update',
        cancelButton: 'Cancel',
        wide: true,
        allowVerticalScrolling: true,
    });

    if (result !== POPUP_RESULT.AFFIRMATIVE) return;

    const checked = id => Boolean(container.querySelector(`#${id}`)?.checked);
    const options2 = diff.mode === 'create'
        ? { placement: checked('pm-opt-top') ? 'top' : 'end' }
        : {
            updateExisting: checked('pm-opt-update'),
            updateHeader: checked('pm-opt-header'),
            addNew: checked('pm-opt-add'),
            reorder: checked('pm-opt-reorder'),
            applyEnabled: checked('pm-opt-enabled'),
            removeExtras: checked('pm-opt-remove'),
        };

    try {
        const stats = await applyDiff(diff, payload, options2);
        const parts = [];
        if (stats.created) parts.push('module added');
        if (stats.updated) parts.push(`${stats.updated} updated`);
        if (stats.added) parts.push(`${stats.added} added`);
        if (stats.removed) parts.push(`${stats.removed} removed`);
        if (stats.reordered) parts.push('reordered');
        toast()?.success(parts.join(', ') || 'No changes were needed', `Module "${name}"`);
        apply();
        renderSettingsPanel();
    } catch (err) {
        warn('apply failed', err);
        toast()?.error(String(err?.message ?? err), 'Import failed');
    }
}

async function showLibraryPicker() {
    const entries = Object.entries(getLibrary());
    if (!entries.length) {
        toast()?.info('The module library is empty.');
        return;
    }
    const container = document.createElement('div');
    container.className = 'pm-dialog';
    container.innerHTML = '<h3 class="pm-dialog-title">Import from library</h3>';
    const list = document.createElement('div');
    list.className = 'pm-library';
    for (const [key, payload] of entries) {
        const row = document.createElement('div');
        row.className = 'pm-library-row';
        const count = payload?.promptModules?.members?.length ?? 0;
        row.innerHTML = `<span class="fa-solid fa-fw fa-box-archive"></span>
            <span class="pm-library-name"></span>
            <small class="pm-muted">${count} prompt(s) · from ${escapeHtml(payload?.promptModules?.source?.preset ?? 'unknown')}</small>`;
        row.querySelector('.pm-library-name').textContent = String(payload?.promptModules?.module?.name ?? key).trim();
        row.addEventListener('click', async () => {
            document.querySelector('.popup .popup-button-close')?.click();
            await importFromLibrary(key);
        });
        list.appendChild(row);
    }
    container.appendChild(list);
    const { callGenericPopup, POPUP_TYPE } = ctx();
    await callGenericPopup(container, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });
}

/* ----------------------------- settings panel ---------------------------- */

const PANEL_ID = 'prompt_modules_settings';

export function mountSettingsPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host) return;

    const wrapper = document.createElement('div');
    wrapper.id = PANEL_ID;
    wrapper.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Prompt Modules</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" title="Turn the whole extension off. Prompt rows go back to SillyTavern's plain list — nothing about your preset changes, and your modules come back when you re-enable it.">
                    <input type="checkbox" id="pm-enabled"> Enable module headers</label>
                <div id="pm-panel-body">
                    <label class="checkbox_label" title="Show a badge on each header with how many prompts are in the module and how many of them are switched on, e.g. 3/7.">
                        <input type="checkbox" id="pm-counts"> Show prompt counts on headers</label>
                    <label class="checkbox_label" title="When you drag a module header, the prompts belonging to that module move with it instead of being left behind. Prompts that never joined the module stay where they are.">
                        <input type="checkbox" id="pm-dragmove"> Dragging a module header moves its prompts too</label>
                    <label class="checkbox_label" title="Also treat any prompt with no content as a header. Leave this off if you use blank prompts as spacers — headers are normally recognised by the marker characters below, and a header is allowed to have content of its own.">
                        <input type="checkbox" id="pm-empty"> Also treat empty prompts as headers</label>
                    <label for="pm-chars" title="A prompt is treated as a module header when its name contains any of these characters. Default is ━ (U+2501). List several to accept more than one, e.g. ━═.">Header marker characters</label>
                    <input id="pm-chars" class="text_pole" type="text" placeholder="━"
                        title="A prompt is treated as a module header when its name contains any of these characters. Default is ━ (U+2501). List several to accept more than one, e.g. ━═.">
                    <div class="pm-panel-buttons">
                        <div class="menu_button" id="pm-collapse-all" title="Fold every module in this preset. Shift+click any header's arrow does the same thing.">Collapse all</div>
                        <div class="menu_button" id="pm-expand-all" title="Unfold every module in this preset.">Expand all</div>
                        <div class="menu_button" id="pm-import" title="Load a module from a .json file exported by this extension and apply it to the preset you have open. You get a preview of every change before anything happens.">Import module…</div>
                        <div class="menu_button caution" id="pm-undo" title="Revert the last module import or removal. Only applies to the preset it happened in, and only for this session.">Undo last change</div>
                    </div>
                    <hr class="sysHR">
                    <label title="Modules you saved for reuse. Saved modules persist across preset switches, so you can improve a module in one preset and apply it to another.">Module library</label>
                    <div id="pm-library-list" class="pm-library"></div>
                    <small class="pm-muted">A header plus the prompts you put in it forms a module. Nothing joins a module on its own — drag a prompt in, use the link icon on its row, or adopt the whole module from the header's ⋮ menu. Collapsing never changes what is sent to the AI.</small>
                </div>
            </div>
        </div>`;
    host.appendChild(wrapper);

    const s = getSettings();

    // Everything below the master switch only means something while modules are
    // on, so dim and disable it rather than leaving dead controls live.
    const body = wrapper.querySelector('#pm-panel-body');
    const syncEnabledState = () => {
        const on = Boolean(getSettings().enabled);
        body.classList.toggle('pm-disabled', !on);
        body.querySelectorAll('input, .menu_button').forEach(el => {
            if (el.tagName === 'INPUT') el.disabled = !on;
            else el.classList.toggle('disabled', !on);
        });
        body.title = on ? '' : 'Turn on "Enable module headers" to use these.';
    };

    const bindCheckbox = (id, key, after) => {
        const el = wrapper.querySelector(`#${id}`);
        el.checked = Boolean(s[key]);
        el.addEventListener('change', () => {
            getSettings()[key] = el.checked;
            save();
            after?.();
            apply();
        });
    };
    bindCheckbox('pm-enabled', 'enabled', syncEnabledState);
    bindCheckbox('pm-counts', 'showCounts');
    bindCheckbox('pm-dragmove', 'moveModuleOnDrag');
    bindCheckbox('pm-empty', 'treatEmptyAsHeader');

    const chars = wrapper.querySelector('#pm-chars');
    chars.value = s.headerChars ?? '';
    chars.addEventListener('change', () => {
        getSettings().headerChars = chars.value;
        save();
        apply();
    });

    wrapper.querySelector('#pm-collapse-all').addEventListener('click', () => setAll(true));
    wrapper.querySelector('#pm-expand-all').addEventListener('click', () => setAll(false));
    wrapper.querySelector('#pm-import').addEventListener('click', () => importFromFile());
    wrapper.querySelector('#pm-undo').addEventListener('click', async () => {
        if (!canUndo()) {
            toast()?.info('Nothing to undo for this preset.');
            return;
        }
        if (await undoLast()) {
            toast()?.success('Reverted the last module change.');
            apply();
        }
    });

    syncEnabledState();
    renderSettingsPanel();
}

export function renderSettingsPanel() {
    const list = document.getElementById('pm-library-list');
    if (!list) return;
    list.textContent = '';
    const entries = Object.entries(getLibrary());
    if (!entries.length) {
        const empty = document.createElement('small');
        empty.className = 'pm-muted';
        empty.textContent = 'No saved modules yet. Use a module\'s ⋮ menu → "Save module to library".';
        list.appendChild(empty);
        return;
    }
    for (const [key, payload] of entries) {
        const row = document.createElement('div');
        row.className = 'pm-library-row';
        const count = payload?.promptModules?.members?.length ?? 0;
        row.innerHTML = `<span class="pm-library-name"></span>
            <small class="pm-muted">${count}</small>
            <span class="pm-library-action fa-solid fa-file-import" title="Import into the current preset"></span>
            <span class="pm-library-action fa-solid fa-file-export" title="Export to file"></span>
            <span class="pm-library-action caution fa-solid fa-trash-can" title="Remove from library"></span>`;
        row.querySelector('.pm-library-name').textContent = String(payload?.promptModules?.module?.name ?? key).trim();
        const [importBtn, exportBtn, deleteBtn] = row.querySelectorAll('.pm-library-action');
        importBtn.addEventListener('click', () => importFromLibrary(key));
        exportBtn.addEventListener('click', () => {
            const label = normalizeName(payload?.promptModules?.module?.name) || 'module';
            downloadJson(`promptmodule-${safeFilename(label)}.json`, payload);
        });
        deleteBtn.addEventListener('click', () => {
            deleteLibraryEntry(key);
            renderSettingsPanel();
        });
        list.appendChild(row);
    }
}

export const __testing = { escapeHtml, safeFilename, MODULE_NAME };

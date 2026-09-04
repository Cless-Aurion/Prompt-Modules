/**
 * Offline tests for the module model and the transfer engine.
 *
 * Runs in plain Node with a stubbed SillyTavern context — no browser, no DOM.
 *
 *   node tests/model.test.mjs
 *   node tests/model.test.mjs --preset "C:/path/to/a/real/preset.json"
 *
 * The synthetic fixture reproduces the shapes that matter in real presets:
 * decorated `━` header names, a header that carries real content, a stale
 * `character_id: 100000` order list beside the live 100001 one, and prompts that
 * exist in `prompts` but not in `prompt_order`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = pathToFileURL(path.join(HERE, '..', 'src') + path.sep).href;

/* ------------------------------- harness -------------------------------- */

let failures = 0;
function assert(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) {
        failures++;
        console.log(`FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
    } else {
        console.log(`pass  ${label}`);
    }
}

function makeContext(preset, name) {
    const store = { [name]: preset };
    let n = 0;
    preset.preset_settings_openai = name;
    // Mirrors preset-manager.js:846-901 — reads and writes land in the preset's
    // own `extensions` bucket, so the test also proves we leave siblings alone.
    return {
        chatCompletionSettings: preset,
        extensionSettings: {},
        saveSettingsDebounced() {},
        uuidv4: () => `uuid-${++n}`,
        getPresetManager: () => ({
            getSelectedPresetName: () => name,
            getCompletionPresetByName: p => store[p],
            readPresetExtensionField: ({ path: p }) => (preset.extensions ?? {})[p] ?? null,
            async writePresetExtensionField({ path: p, value }) {
                preset.extensions = preset.extensions ?? {};
                preset.extensions[p] = value;
            },
        }),
    };
}

/* ------------------------------- fixture -------------------------------- */

function syntheticPreset() {
    const prompts = [];
    const order = [];
    const add = (identifier, name, content, enabled = true, inOrder = true) => {
        prompts.push({ identifier, name, content, role: 'system', system_prompt: false });
        if (inOrder) order.push({ identifier, enabled });
    };

    add('main', 'Main Prompt', 'You are a helpful assistant.');
    add('h-wc', '━━━━━ Word Count', '');                    // empty header
    add('wc-a', 'Word Count - Adaptive', 'Aim for 300 words.');
    add('wc-b', 'Word Count - Edit Here', 'Adjust length here.', false);
    add('h-content', '━━━━ Content ', '</source>');          // header WITH content
    add('c-a', 'Content Rules', 'Stay in genre.');
    add('h-pace', '━━━━━(๑•᎑•マ Pace', '');                  // decorated header
    add('p-a', 'Slow Burn', 'Take your time.');
    add('orphan', 'Never Listed', 'x', true, false);         // in prompts, not in order

    return {
        prompts,
        prompt_order: [
            { character_id: 100000, order: [{ identifier: 'main', enabled: true }] }, // stale
            { character_id: 100001, order },
        ],
        extensions: { regex_scripts: [{ id: 'pre-existing' }] },
    };
}

/* --------------------------------- run ---------------------------------- */

const presetArg = process.argv.indexOf('--preset');
const usingReal = presetArg !== -1;
const basePreset = usingReal
    ? JSON.parse(fs.readFileSync(process.argv[presetArg + 1], 'utf8'))
    : syntheticPreset();

let context = makeContext(structuredClone(basePreset), 'Source');
globalThis.SillyTavern = { getContext: () => context };

const modules = await import(SRC + 'modules.js');
const transfer = await import(SRC + 'transfer.js');

console.log(`\n# model (${usingReal ? 'real preset' : 'synthetic fixture'})`);
assert('resolves the live order list, not the stale one', await modules.initModel(), 100001);

const model = modules.deriveModel();
if (!usingReal) {
    assert('modules found', model.modules.length, 3);
    assert('nothing is a member until it is put in a module',
        model.modules.every(g => g.members.length === 0), true);
    assert('prompts under a header are offered as candidates',
        model.modules.map(g => g.candidates.length), [2, 1, 1]);
    assert('a header may carry real content', model.modules[1].header.content, '</source>');
    assert('decoration is stripped for identity', model.modules.map(g => g.normalized), ['word count', 'content', 'pace']);
    assert('orphan prompts appear nowhere in the model',
        model.modules.every(g => ![...g.members, ...g.candidates]
            .some(m => m.prompt.identifier === 'orphan')), true);
}
assert('every module has a header', model.modules.every(g => Boolean(g.header)), true);

console.log('\n# membership is opt-in');
const settingsMod = await import(SRC + 'settings.js');
{
    const before = modules.deriveModel();
    const host = before.modules.find(g => g.candidates.length >= 1);
    const first = host.candidates[0].prompt.identifier;
    const candidateCount = host.candidates.length;

    await settingsMod.updateMemberships([[first, host.id]], []);
    let now = modules.deriveModel().modules.find(g => g.id === host.id);
    assert('joining moves a prompt from candidate to member',
        [now.members.length, now.candidates.length], [1, candidateCount - 1]);

    await settingsMod.updateMemberships([], [first]);
    now = modules.deriveModel().modules.find(g => g.id === host.id);
    assert('leaving puts it back as a candidate',
        [now.members.length, now.candidates.length], [0, candidateCount]);
    assert('membership changes never touch prompt_order',
        modules.getOrderList(context.chatCompletionSettings).length, model.orderList.length);

    // An assignment only counts while the prompt is still under that header.
    await settingsMod.updateMemberships([[first, 'a-different-header']], []);
    assert('a stale assignment cannot contradict what is on screen',
        modules.deriveModel().modules.find(g => g.id === host.id).members.length, 0);
    await settingsMod.updateMemberships([], [first]);

    await settingsMod.updateMemberships(host.candidates.map(c => [c.prompt.identifier, host.id]), []);
    now = modules.deriveModel().modules.find(g => g.id === host.id);
    assert('adopting takes in everything under the header',
        [now.members.length, now.candidates.length], [candidateCount, 0]);
}

// The transfer suite below needs populated modules.
async function adoptAll() {
    for (const g of modules.deriveModel().modules) {
        if (g.candidates.length) {
            await settingsMod.updateMemberships(g.candidates.map(c => [c.prompt.identifier, g.id]), []);
        }
    }
}
await adoptAll();
assert('every module is populated after adopting',
    modules.deriveModel().modules.every(g => g.candidates.length === 0), true);


console.log('\n# export');
const adopted = modules.deriveModel();
const target = adopted.modules.find(g => g.normalized === 'word count') ?? adopted.modules[0];
const payload = await transfer.buildModulePayload(target.id);
assert('payload validates', transfer.validatePayload(payload), null);
assert('omits prompt_order so a stock import cannot reorder', 'prompt_order' in payload.data, false);
assert('carries header + members', payload.data.prompts.length, target.members.length + 1);
assert('pre-existing extension data is preserved',
    Array.isArray(context.getPresetManager().readPresetExtensionField({ path: 'regex_scripts' })), true);

console.log('\n# re-import into the same preset is a no-op');
let diff = transfer.buildDiff(payload);
assert('matched by stable key', diff.matchedBy, 'stable key');
assert('nothing to do', [diff.updates.filter(u => u.changed).length, diff.additions.length, diff.extras.length], [0, 0, 0]);

console.log('\n# divergent target');
// A preset that has never seen this extension: drop any metadata a previous run
// (or a live session) may have already written into the source file.
const freshTarget = structuredClone(basePreset);
delete freshTarget.extensions?.promptModules;
context = makeContext(freshTarget, 'Target');
await modules.initModel();
await adoptAll();
const tModel = modules.deriveModel();
const tModule = tModel.modules.find(g => g.normalized === target.normalized);
const stale = tModule.members[0].prompt;
const originalContent = stale.content;
stale.content = 'OUTDATED';
const order = modules.getOrderList(context.chatCompletionSettings);
const dropped = tModule.members[tModule.members.length - 1].prompt.identifier;
order.splice(order.findIndex(e => e.identifier === dropped), 1);
context.chatCompletionSettings.prompts.push({ identifier: 'local-only', name: 'Local Only', content: 'x', role: 'system', system_prompt: false });
order.splice(order.findIndex(e => e.identifier === tModule.id) + 1, 0, { identifier: 'local-only', enabled: true });
await settingsMod.updateMemberships([['local-only', tModule.id]], []);

diff = transfer.buildDiff(payload);
assert('falls back to identifier matching', diff.matchedBy, 'prompt identifier');
assert('sees the stale prompt', diff.updates.filter(u => u.changed).length, 1);
assert('sees the missing prompt', diff.additions.length, 1);
assert('sees the local-only prompt', diff.extras.map(e => e.prompt.identifier), ['local-only']);

console.log('\n# apply, keeping local-only prompts');
const orderBefore = modules.getOrderList(context.chatCompletionSettings).length;
const promptsBefore = context.chatCompletionSettings.prompts.length;
await transfer.applyDiff(diff, payload, {
    updateExisting: true, updateHeader: true, addNew: true,
    removeExtras: false, applyEnabled: false, reorder: true,
});
assert('stale content was refreshed',
    context.chatCompletionSettings.prompts.find(p => p.identifier === stale.identifier).content, originalContent);
assert('missing prompt was restored', modules.getOrderList(context.chatCompletionSettings).length, orderBefore + 1);
assert('local-only prompt survived',
    modules.getOrderList(context.chatCompletionSettings).some(e => e.identifier === 'local-only'), true);
assert('re-applying changes nothing', transfer.buildDiff(payload).updates.filter(u => u.changed).length, 0);
// The dropped member was still present in `prompts` as an orphan, so re-listing it
// must adopt that object rather than pile up a duplicate with a new identifier.
assert('an orphaned prompt is re-listed, not duplicated',
    context.chatCompletionSettings.prompts.length, promptsBefore);
assert('the re-listed prompt kept its original identifier',
    modules.getOrderList(context.chatCompletionSettings).some(e => e.identifier === dropped), true);

console.log('\n# undo');
assert('undo offered', transfer.canUndo(), true);
await transfer.undoLast();
assert('order restored', modules.getOrderList(context.chatCompletionSettings).length, orderBefore);
assert('content restored to the stale value',
    context.chatCompletionSettings.prompts.find(p => p.identifier === stale.identifier).content, 'OUTDATED');

console.log('\n# creating a module that does not exist yet');
context = makeContext(structuredClone(basePreset), 'Blank');
await modules.initModel();
const blank = context.chatCompletionSettings;
const gone = modules.deriveModel().modules.find(g => g.normalized === target.normalized);
const doomed = new Set([gone.id, ...gone.members.map(m => m.prompt.identifier)]);
const bOrder = modules.getOrderList(blank);
for (let i = bOrder.length - 1; i >= 0; i--) if (doomed.has(bOrder[i].identifier)) bOrder.splice(i, 1);
blank.prompts = blank.prompts.filter(p => !doomed.has(p.identifier));
const modulesBefore = modules.deriveModel().modules.length;

const createDiff = transfer.buildDiff(payload);
assert('detects that the module is absent', createDiff.mode, 'create');
const createStats = await transfer.applyDiff(createDiff, payload, { placement: 'end' });
assert('module was created', createStats.created, true);
assert('module count restored', modules.deriveModel().modules.length, modulesBefore + 1);
assert('added at the end', modules.deriveModel().modules.at(-1).normalized, target.normalized);
assert('and is now in sync', transfer.buildDiff(payload).updates.filter(u => u.changed).length, 0);

console.log('\n# removing local-only prompts is de-listing, not deleting');
context = makeContext(structuredClone(basePreset), 'Remove');
await modules.initModel();
await adoptAll();
const rm = context.chatCompletionSettings;
const rmModule = modules.deriveModel().modules.find(g => g.normalized === target.normalized);
rm.prompts.push({ identifier: 'local-only', name: 'Local Only', content: 'x', role: 'system', system_prompt: false });
modules.getOrderList(rm).splice(
    modules.getOrderList(rm).findIndex(e => e.identifier === rmModule.id) + 1, 0,
    { identifier: 'local-only', enabled: true });
await settingsMod.updateMemberships([['local-only', rmModule.id]], []);
const rmDiff = transfer.buildDiff(payload);
await transfer.applyDiff(rmDiff, payload, {
    updateExisting: true, updateHeader: true, addNew: true,
    removeExtras: true, applyEnabled: false, reorder: true,
});
assert('removed from the visible list', modules.getOrderList(rm).some(e => e.identifier === 'local-only'), false);
assert('but the prompt still exists and is recoverable',
    rm.prompts.some(p => p.identifier === 'local-only'), true);

console.log('\n# deleting a module');
{
    context = makeContext(structuredClone(basePreset), 'Delete');
    await modules.initModel();
    await adoptAll();
    const del = context.chatCompletionSettings;
    const before = { prompts: del.prompts.length, order: modules.getOrderList(del).length };
    const before2Modules = modules.deriveModel().modules.length;
    const g = modules.deriveModel().modules.find(x => x.members.length >= 1);
    const memberIds = g.members.map(m => m.prompt.identifier);

    // Header only: its prompts survive and are simply no longer in a module.
    const stats = await transfer.deleteModule(g.id, {});
    assert('only the header was removed', stats.removed, 1);
    assert('nothing was actually deleted', stats.deleted, 0);
    assert('the header prompt object SURVIVES, as in stock SillyTavern',
        del.prompts.some(p => p && p.identifier === g.id), true);
    assert('the prompts array is untouched', del.prompts.length, before.prompts);
    assert('the header left prompt_order', modules.getOrderList(del).length, before.order - 1);
    assert('its prompts were kept',
        memberIds.every(id => del.prompts.some(p => p && p.identifier === id)), true);
    // Removing a module erases the arrangement entirely, even when nothing was
    // deleted: re-adding the same header must give a fresh empty module, never a
    // resurrected one.
    assert('every module relationship is forgotten',
        memberIds.some(id => settingsMod.getMemberships()[id]), false);
    assert('the header keeps no sync link either',
        Boolean(settingsMod.readPresetMeta().links?.[g.id]), false);
    assert('the module is gone from the model',
        modules.deriveModel().modules.some(x => x.id === g.id), false);
    assert('one fewer module', modules.deriveModel().modules.length, before2Modules - 1);

    await transfer.undoLast();
    assert('undo restores the deleted module',
        [del.prompts.length, modules.getOrderList(del).length], [before.prompts, before.order]);

    // With contents: header and members all go.
    await adoptAll();
    const g2 = modules.deriveModel().modules.find(x => x.members.length >= 1);
    const n = g2.members.length;
    // Middle step: de-list members but keep every prompt object recoverable.
    const orderBeforeRemove = modules.getOrderList(del).length;
    const promptsBeforeRemove = del.prompts.length;
    const memberIds2 = g2.members.map(m => m.prompt.identifier);
    const statsRemove = await transfer.deleteModule(g2.id, { removeContents: true });
    assert('header and members left the list', statsRemove.removed, n + 1);
    assert('but every prompt object survives', del.prompts.length, promptsBeforeRemove);
    assert('all of them are recoverable from the dropdown',
        memberIds2.every(id => del.prompts.some(p => p && p.identifier === id)), true);
    assert('the list shrank by header + members',
        modules.getOrderList(del).length, orderBeforeRemove - (n + 1));
    await transfer.undoLast();

    // Strongest step: erase them.
    await adoptAll();
    const g3 = modules.deriveModel().modules.find(x => x.id === g2.id) ?? modules.deriveModel().modules.find(x => x.members.length >= 1);
    const n3 = g3.members.length;
    const promptsBeforePurge = del.prompts.length;
    const stats2 = await transfer.deleteModule(g3.id, { deleteContents: true });
    assert('header and members were deleted', stats2.removed, n3 + 1);
    assert('and really erased', stats2.deleted, n3 + 1);
    assert('prompts array shrank by the same amount',
        del.prompts.length, promptsBeforePurge - (n3 + 1));
    assert('deleting DOES clear the relationships, leaving nothing dangling',
        Object.entries(settingsMod.getMemberships())
            .every(([pid, hid]) => del.prompts.some(p => p && p.identifier === pid)
                                && del.prompts.some(p => p && p.identifier === hid)), true);
    assert('nothing dangles in prompt_order',
        modules.getOrderList(del).every(e => del.prompts.some(p => p && p.identifier === e.identifier)), true);
}

console.log('\n# modules behave as a contiguous unit');
{
    context = makeContext(structuredClone(basePreset), 'Unit');
    await modules.initModel();
    await adoptAll();
    const s0 = context.chatCompletionSettings;
    const order = () => modules.getOrderList(s0);
    const ids = () => order().map(e => e.identifier);
    // Removing the entry first shifts everything below it, so a target index
    // computed beforehand has to be adjusted or the prompt lands one slot late.
    const move = (id, to) => {
        const arr = order();
        const i = arr.findIndex(e => e.identifier === id);
        const [e] = arr.splice(i, 1);
        arr.splice(i < to ? to - 1 : to, 0, e);
    };

    const m0 = modules.deriveModel();
    const g = m0.modules.find((x, i) => x.members.length >= 2 && i + 1 < m0.modules.length);
    const next = m0.modules[m0.modules.indexOf(g) + 1];
    // Must come from a third module: taking it from `next` would make the move a no-op.
    const outsider = m0.modules.find(x => x.id !== g.id && x.id !== next.id && x.members.length)?.members[0].prompt.identifier;

    // Landing directly under a header joins that module at the top.
    move(outsider, ids().indexOf(next.id) + 1);
    let outcome = modules.reconcileAfterDrop(outsider);
    assert('dropped just under a header, so it joins at the top',
        outcome.assign.some(([id, gid]) => id === outsider && gid === next.id), true);
    await settingsMod.updateMemberships(outcome.assign, outcome.remove);
    assert('and it really is the first member',
        modules.deriveModel().modules.find(x => x.id === next.id).members[0].prompt.identifier, outsider);

    // REGRESSION: dropping into a module must ADD the prompt, never sever the
    // members below it. Judging the drop before it resolves made the newcomer
    // break the run at position 1 and evict every real member underneath.
    {
        const host = modules.deriveModel().modules.find(x => x.members.length >= 3 && x.id !== next.id);
        const stranger = host && modules.deriveModel().modules
            .find(x => x.id !== host.id && x.members.length >= 2)?.members[0].prompt.identifier;
        if (host && stranger) {
        const hostMembers = host.members.map(m => m.prompt.identifier);

        // Straight to the top of the module.
        move(stranger, ids().indexOf(host.id) + 1);
        let out = modules.reconcileAfterDrop(stranger);
        await settingsMod.updateMemberships(out.assign, out.remove);
        let now = modules.deriveModel().modules.find(x => x.id === host.id);
        assert('dropping at the top of a module keeps every existing member',
            now.members.map(m => m.prompt.identifier), [stranger, ...hostMembers]);

        // And into the middle of it.
        const mid = modules.deriveModel().modules.find(x => x.id === host.id);
        const midMembers = mid.members.map(m => m.prompt.identifier);
        const other = modules.deriveModel().modules
            .find(x => x.id !== host.id && x.members.length >= 2)?.members[0].prompt.identifier;
        if (other) {
            move(other, mid.members[1].index);
            out = modules.reconcileAfterDrop(other);
            await settingsMod.updateMemberships(out.assign, out.remove);
            now = modules.deriveModel().modules.find(x => x.id === host.id);
            const expected = [...midMembers];
            expected.splice(1, 0, other);
            assert('dropping into the middle of a module just adds it',
                now.members.map(m => m.prompt.identifier), expected);
            assert('and the module is still one contiguous run',
                now.members.every((m, i, arr) => i === 0 || m.index === arr[i - 1].index + 1), true);
        }
        }
    }

    // Landing after the last member is landing BELOW the module, not in it. This is
    // the top-half-of-the-next-header case: it leaves the module above.
    const g2 = modules.deriveModel().modules.find(x => x.id === g.id);
    const mover = g2.members[0].prompt.identifier;
    const lastMember = g2.members[g2.members.length - 1].prompt.identifier;
    move(mover, ids().indexOf(lastMember) + 1);
    outcome = modules.reconcileAfterDrop(mover);
    assert('dropped past the last member, so it leaves the module',
        outcome.remove.includes(mover), true);
    assert('and it is not re-assigned anywhere', outcome.assign.length, 0);
    await settingsMod.updateMemberships(outcome.assign, outcome.remove);
    assert('the module no longer counts it',
        modules.deriveModel().modules.find(x => x.id === g.id).members
            .some(m => m.prompt.identifier === mover), false);

    // A member stranded below a non-member is no longer part of the unit.
    const g3 = modules.deriveModel().modules.find(x => x.members.length >= 2);
    if (g3) {
        const stranded = g3.members[g3.members.length - 1].prompt.identifier;
        const loose = g3.candidates[0]?.prompt.identifier
            ?? modules.deriveModel().unassigned.find(u => !modules.containingModule(modules.deriveModel(), u.prompt.identifier))?.prompt.identifier;
        if (loose) {
            move(loose, ids().indexOf(stranded));
            const broken = modules.deriveModel();
            assert('a member cut off by a stranger drops out of the module',
                broken.modules.find(x => x.id === g3.id).members.some(m => m.prompt.identifier === stranded), false);
            assert('and its stale mark is reported for cleanup',
                broken.stale.includes(stranded), true);
        }
    }
}

console.log('\n# taking a prompt out moves it only when it has to');
{
    context = makeContext(structuredClone(basePreset), 'Edge');
    await modules.initModel();
    await adoptAll();
    const s0 = context.chatCompletionSettings;
    const ids = () => modules.getOrderList(s0).map(e => e.identifier);
    const g = modules.deriveModel().modules.find(x => x.members.length >= 3);

    if (g) {
        const lengthBefore = ids().length;
        // Last member: nothing of the module below it, so it must stay put.
        // Eject runs while the prompt is still a member, then membership is
        // dropped — the same order the row toggle uses.
        const last = g.members[g.members.length - 1].prompt.identifier;
        const posBefore = ids().indexOf(last);
        assert('a prompt at the module edge is left where it is',
            modules.ejectToModuleEdge(last, g.id), false);
        await settingsMod.updateMemberships([], [last]);
        assert('its position really did not change', ids().indexOf(last), posBefore);

        // First member: members remain below it, so it moves to the nearer edge.
        const g2 = modules.deriveModel().modules.find(x => x.id === g.id);
        const first = g2.members[0].prompt.identifier;
        const restBelow = g2.members.slice(1).map(m => m.prompt.identifier);
        assert('a prompt with members below it is moved out',
            modules.ejectToModuleEdge(first, g.id), true);
        await settingsMod.updateMemberships([], [first]);
        assert('the rest of the module survives intact, not stranded',
            modules.deriveModel().modules.find(x => x.id === g.id).members
                .map(m => m.prompt.identifier), restBelow);
        const after = ids();
        assert('to just above the header, the nearer edge',
            after[after.indexOf(g.id) - 1], first);
        assert('nothing was added or lost', after.length, lengthBefore);
        assert('and the module is contiguous again',
            modules.deriveModel().modules.find(x => x.id === g.id).members
                .every((m, i, arr) => i === 0 || m.index === arr[i - 1].index + 1), true);
    }
}



console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);

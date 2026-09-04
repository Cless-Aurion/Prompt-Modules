# Prompt Modules — architecture notes

Third-party **SillyTavern 1.18.0** UI extension. Adds collapsible, shareable modules
to the Chat Completion prompt manager. Read this before changing anything; several
decisions here look arbitrary until you know what they are avoiding.

**Scope:** organisation only. It must never change prompt construction, ordering
semantics, or what is sent to the model. Collapsing, module assignment and
membership are presentation and metadata. The only things that legitimately move
prompts are a drag (SillyTavern's own reordering) and the explicit eject/import
operations below.

---

## Layout

```
Prompt-Modules/
├── manifest.json        js: index.js, css: style.css, minimum_client_version 1.18.0
├── index.js             boot on APP_READY, event wiring, mounts interceptors
├── style.css
├── tests/model.test.mjs offline suite (no browser, no DOM)
└── src/
    ├── compat.js        THE ONLY FILE THAT TOUCHES SILLYTAVERN INTERNALS
    ├── constants.js     ids, selectors, CSS class names, synced prompt fields
    ├── modules.js       the model: walk/deriveModel, drop + eject rules
    ├── collapse.js      DOM decoration, MutationObserver, drag guards, row toggle
    ├── transfer.js      export / match / diff / apply / deleteModule / undo
    ├── settings.js      extension_settings + per-preset metadata (+ cache)
    ├── ui.js            module menu, dialogs, settings panel, click interceptors
    └── log.js
```

Plain ES modules loaded directly by the browser. **No build step.**

---

## Development setup

The repo lives outside the SillyTavern tree and is surfaced to it with a directory
link, so the working copy stays independent of the install:

- repo: `<repo>`
- link: `<sillytavern>/public/scripts/extensions/third-party/Prompt-Modules`

On Windows a directory junction does this without admin rights, e.g.
`mklink /J "<sillytavern>\public\scripts\extensions\third-party\Prompt-Modules" "<repo>"`.

Use a dedicated development instance of SillyTavern, on its own port and its own data
directory, kept separate from any instance holding real data.

Testing:

```bash
node tests/model.test.mjs                     # synthetic fixture
node tests/model.test.mjs --preset "<path>"   # any Chat Completion preset file
```

Run **both**. The synthetic fixture is small and misses cases (it has no module with
3+ members, so some blocks self-skip); a large preset — a few hundred prompts, a
few dozen headers, and some prompts listed but never adopted — exercises the rest.
The suite stubs `SillyTavern.getContext()`, so `src/` must stay importable in plain
Node — keep DOM access inside functions, never at module top level.

Browser verification matters; much of this is DOM behaviour. Useful invariant checks
after any change, against whichever preset you test with: `prompt_order` length and
prompt count both unchanged, `deriveModel().stale.length === 0`, and **idle DOM
mutations = 0**.

---

## How it integrates with SillyTavern

Go through `getContext()` wherever possible. `src/compat.js` isolates the rest:

- `chatCompletionSettings` **is** core's live `oai_settings` object. Mutating it
  mutates SillyTavern's live state; `saveSettingsDebounced()` persists it.
- `getPresetManager('openai')` gives `readPresetExtensionField` /
  `writePresetExtensionField` / `savePreset` / `getCompletionPresetByName`.
- **One internal import**, deliberately: `import('../../../../openai.js')` for the
  `promptManager` singleton, because `getContext()` does not expose it and there is
  no other way to trigger a re-render. Guarded, with graceful fallback.
  `render(false)` is used — the branch that skips the dry-run `Generate()`.
- Saving to the preset FILE reuses core's own button (`#update_oai_preset.click()`)
  instead of reimplementing the save, which keeps us on core's field whitelist.

Live edits go to `oai_settings` (auto-saved to settings.json). The preset FILE only
changes when the user saves the preset — except `writePresetExtensionField`, which
writes the file immediately. Only call it when metadata actually changes.

---

## Where state lives, and why it is split

| Data | Location | Why |
|---|---|---|
| membership, sync links | `preset.extensions.promptModules` | official preset field; travels with save/export/import/rename; ignored by stock ST |
| collapse state, options, library, undo | `extension_settings['Prompt-Modules']` | per-user UI state — a chevron click must never dirty a preset |

Preset metadata shape:
`{ v, links: { [headerId]: { moduleKey, memberKeys } }, members: { [promptId]: headerId } }`.

**Why not a custom top-level preset key:** saving rebuilds the preset from the
`settingsToUpdate` whitelist (`openai.js:4477`) and loading iterates
`Object.keys(default_settings)` (`openai.js:4239`), so any other key is silently
destroyed. `extensions` is in both lists (`openai.js:400`, `:508`) — the only safe
home. Removing the extension leaves presets fully valid.

`readPresetMeta` is **cached by preset name** because the model is derived on every
re-decoration. `invalidatePresetMeta()` on preset change; writes refresh the cache.

---

## The module model (`src/modules.js`)

A **header** is a prompt whose name contains a marker char (default `━`, U+2501;
configurable; optional "empty content counts too"). A header opens a positional
**span** running to the next header.

**Membership is opt-in and contiguous.** A module's members are the *unbroken run* of
member-marked prompts directly under the header. The first non-member ends the run;
anything below is outside the module even if it still carries an assignment. Those
orphaned marks are reported as `model.stale` for cleanup. Prompts in the span that
have not joined are `candidates` — visible even when the module is collapsed.

Two invariants keep stored data honest:
1. an assignment only counts while the prompt is still under that header, so
   metadata can never contradict the screen;
2. nothing is written to a preset until a prompt actually joins a module.

`walk(orderList, byId, assignments, ignoreIdentifier)` is the shared traversal;
`deriveModel()` is `walk` with current assignments.

### Drop rules — `reconcileAfterDrop(promptId)`

Walks **once ignoring the dragged prompt** (so it is judged against each module's
block as it actually stands, and cannot split the module it is joining), decides
membership, then walks **again with the resulting assignments** to find genuinely
stranded marks. Computing staleness before the drop resolved was a real bug: a
prompt dropped at the top of a module evicted every member beneath it.

- lands directly under the header, or in among the members → **joins**, existing
  members untouched;
- lands after the last member → that is *below* the module → **leaves**.

That asymmetry is what gives the next header's half-way point its meaning: top half
puts the prompt above the header and out of the module above; bottom half puts it at
the top of the module below. **Consequence:** you cannot append to a module by
dragging past its last member; use the row toggle. Intentional.

### Leaving — `ejectToModuleEdge(promptId, headerId)`

Moves the prompt to the module's *own* nearer edge (above the header, or past the
last member), **only** when it would otherwise sit among remaining members. Already
at the edge → stays exactly put. Ties resolve upward.

**Order of operations is load-bearing:** the row toggle calls `ejectToModuleEdge`
**while the prompt is still a member**, then clears membership. Clearing first
breaks the run at that prompt and strands every member below it, dissolving the
module. Do not reorder these two steps.

### Core prompts — `isCorePrompt()`

`marker === true || system_prompt === true`. SillyTavern's structural prompts (Chat
History, World Info before/after, Card JB, …). Excluded from bulk adopt, and the
adopt walk **stops** at the first one rather than skipping past it — taking prompts
below would leave them cut off from the header, hence inert. They can still be added
individually via the row toggle, and are never de-listed or deleted by module removal.

---

## Import / export (`src/transfer.js`)

The export payload is a **superset of core's envelope that deliberately omits
`data.prompt_order`**. Such a file still passes core's `validateObject`, and since
`Object.assign(target, undefined)` is a no-op, importing one with SillyTavern's own
button can only add/update prompts — never scramble order.

Matching, most reliable first: stored stable key → prompt `identifier` → normalised
name (`━━━━━ Word Count` → `word count`). The first successful name match records
stable keys on both sides, so later syncs are exact and survive renames. Member
matching also considers **candidates**, otherwise importing into a module whose
prompts were never adopted would duplicate every one of them.

`buildDiff` → preview dialog → `applyDiff(diff, payload, options)`. Options:
`updateExisting`, `updateHeader`, `addNew`, `removeExtras`, `applyEnabled`,
`reorder`, `placement`. Defaults are non-destructive: `removeExtras` off, and
"remove" only de-lists (the prompt object survives). Imported prompts are
**explicitly enrolled** — landing in a span does not imply membership. An import
matching an orphan (in `prompts` but not in `prompt_order`) adopts it in place
rather than creating a duplicate. Only `SYNCED_PROMPT_FIELDS` are copied;
`identifier` never is. Every apply takes an undo snapshot.

The preview **never truncates** — it is the last thing shown before prompts change.

### Module removal — `deleteModule(headerId, { removeContents, deleteContents })`

Three escalating levels, default matching SillyTavern's own red chain:

| options | effect |
|---|---|
| `{}` | header leaves `prompt_order`; **prompt object survives**, recoverable from the footer "insert prompt" dropdown |
| `removeContents` | members de-listed too, all still recoverable |
| `deleteContents` | header and members erased from `prompts` |

**Removal always clears the arrangement completely** (memberships + the header's
sync link), whether or not anything was deleted. This was a deliberate reversal of
an earlier design: re-adding a header must give a *fresh empty module*, never a
resurrected one, so splitting and rebuilding modules stays predictable.

---

## Hard invariants — do not break these

1. **Never remove `completion_prompt_manager_prompt_draggable` from a row, and never
   inject an element carrying it.** On drag, core rebuilds `prompt_order` from
   `sortable('toArray', {attribute:'data-pm-identifier'})`
   (`PromptManager.js:1918-1937`). A row missing from that enumeration is silently
   deleted from `prompt_order` and nothing restores it; unknown identifiers become
   `undefined` entries.
2. **Collapse by hiding rows in place** (`display:none`). Never detach, never
   re-parent prompt rows under a wrapper. Hidden rows still appear in `toArray`, so
   CSS-only collapse provably cannot drop, reorder or disable anything.
3. **Never narrow the sortable `items` selector** (e.g. to `:visible`) — that would
   delete collapsed prompts from `prompt_order`.
4. **Resolve `prompt_order` by `character_id === 100001`**, never by array index.
   Real presets carry a stale `100000` list alongside the live one.
5. `enabled` lives **only** in `prompt_order[].order[].enabled`, never on the prompt
   object (`prompt.enabled` exists on some prompts but is vestigial and unread).
6. Never de-list or delete `system_prompt`/`marker` prompts. De-listing a marker
   such as `chatHistory` silently stops that content being sent at all.
7. Extra fields on a prompt object cannot reach the API — generation copies through
   `new Prompt(...)` (`PromptManager.js:182`), a fixed 12-field destructure. This is
   why our metadata is structurally incapable of affecting generation.

---

## The decorate feedback loop — the recurring hazard

The prompt manager **emits no events at all** and wipes its container with
`innerHTML = ''` on every render (`PromptManager.js:1604`). Only
`#completion_prompt_manager` survives; the `<ul>` is replaced. So decoration is
re-applied from a `MutationObserver` on that container, observing **childList only**
(never attributes).

This has bitten the project **three times**. The observer fires on our own DOM
changes, so **`decorate()` must be idempotent at the childList level**:

- assign `textContent` only when the value actually differs — an unconditional write
  replaces a child text node, which is a mutation, which re-triggers the observer,
  forever. Deferred, this appeared as *module flicker*; synchronous, it **froze the
  tab**;
- never strip-and-recreate an element that will immediately be re-added — this is
  why `clearHeaderArtifacts` deliberately leaves the member toggle alone;
- attribute/class/`title` writes are safe; they are not observed.

Also:
- decoration runs **synchronously inside the observer callback** (a microtask, so
  pre-paint). Deferring it lets an undecorated frame paint — that was the flicker.
- `apply()` uses `setTimeout`, **not `requestAnimationFrame`**: frames are starved
  when the panel is not painting, which latched the `scheduled` flag on forever and
  silently killed all future re-decoration.
- a circuit breaker (60 passes/second) warns instead of locking the tab.

**Regression check:** idle DOM mutations on `#completion_prompt_manager` must be
**0**. Anything else means the loop is back.

---

## Other non-obvious SillyTavern behaviour

- **Drawers auto-close** when a click's target has no `.openDrawer` ancestor
  (`script.js:12120`). A menu mounted on `<body>` therefore closes the whole panel;
  the module menu mounts **inside the open drawer**.
- **Renaming a preset is not a rename.** `renamePreset` saves under the new name and
  deletes the old (`preset-manager.js:504`), and for Chat Completion calls
  `savePreset(newName)` with no settings — `getPresetSettings()` has no `openai`
  case, so it writes `{}` and core follows up with its own "Update current preset"
  to repair it. `extensions` is copied across explicitly by core, but **anything
  keyed by preset NAME must be migrated on `PRESET_RENAMED`** or it is orphaned —
  exactly how collapse state was lost.
- **Core's `PromptManager.import()` is unusable** for partial imports: it applies
  order with `Object.assign(orderArray, incoming)` (`:1854`), an index-based
  overwrite that scrambles order and can duplicate identifiers. We never call it.
- `getPresetSettings()` has **no `openai` case** → returns `{}`. Never call
  `savePreset(name)` without an explicit settings object; it writes an empty preset.
- Popup buttons are `div.popup-button-ok` / `.popup-button-cancel`, not `<button>`.
- Prompts can exist in `prompts` but not in `prompt_order` ("orphans"). They are
  invisible in the list and must be preserved.
- An empty-content prompt costs zero tokens and is filtered from the payload. The
  one exception: an *enabled* empty prompt with role `user`/`assistant` survives
  `squashSystemMessages` and can change message boundaries. Header prompts with
  `role: system` are unaffected.

---

## Things NOT to do

- Do not wrap prompt rows in `<details>`/`<summary>` the way other prompt-folding
  extensions do, and do not monkey-patch `getPromptCollection` to filter disabled
  headers' children — that changes generation, which is out of scope.
- Do not store metadata as a new top-level preset key (whitelisted away) or on
  prompt objects (destroyed by core's import merge).
- Do not make membership positional again. It was tried and reverted: prompts must
  be able to sit under a header without belonging to it.
- Do not reverse the eject/clear ordering in the row toggle (see above).
- Do not modify SillyTavern core. All behaviour lives in this extension.

---

## Current state and known limitations

Substantially complete; polishing and bug-fixing remain.

- **Cross-preset push is designed for but not built.** Applying a module to a preset
  that is not currently open is the obvious next feature. The mechanism is verified:
  `savePreset(name, obj, { skipUpdate: true })` writes a non-selected preset — but
  it does **not** refresh in-memory `openai_settings`, so a write must also update
  the object returned by `getCompletionPresetByName` or it goes stale.
- Cannot append to a module by dragging past its last member (intentional; use the
  row toggle).
- "Take all N out" from the ⋮ menu does not eject prompts, unlike the row toggle —
  ejecting a whole module would scatter ordering. Deliberate; revisit if asked.
- Name normalisation prefers an ASCII label and falls back to any letters/digits;
  heavily decorated non-Latin module names could match imprecisely. Mitigated by
  stable keys and the import preview.
- Dragging an **expanded** header carries only its members; prompts that never
  joined stay behind.
- Undo is single-level and session-only, and only applies to the preset it happened
  in.
- Shift+click on a header's on/off switch flips only the members, leaving the
  header's own switch alone (headers are kept on as visual anchors).

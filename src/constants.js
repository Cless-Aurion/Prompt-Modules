/**
 * Shared constants for the Prompt Modules extension.
 *
 * Everything here that refers to SillyTavern DOM or data shapes was verified
 * against SillyTavern 1.18.0 (release, 8172dcd0e). See README "Compatibility notes".
 */

/** Folder name of this extension. Also the key used in `extension_settings`. */
export const MODULE_NAME = 'Prompt-Modules';

/** Namespace used inside a preset's official `extensions` bucket. */
export const NS = 'promptModules';

/** Stable container that survives every prompt-manager re-render (index.html:2265). */
export const CONTAINER_ID = 'completion_prompt_manager';

/** The <ul> holding prompt rows. Re-created on every render, so never cache it. */
export const LIST_ID = 'completion_prompt_manager_list';

/**
 * Class marking a row as sortable (PromptManager.js:1922).
 * NEVER add this to an element we inject, and never remove it from a real row:
 * the sortable `update` handler rebuilds prompt_order from exactly this selector.
 */
export const DRAGGABLE_CLASS = 'completion_prompt_manager_prompt_draggable';

/** Attribute carrying a prompt identifier on each row (PromptManager.js:1740). */
export const ID_ATTR = 'data-pm-identifier';

/** Fallback for promptManager.configuration.promptOrder.dummyId (openai.js:689). */
export const GLOBAL_DUMMY_ID = 100001;

/** Default character(s) marking a prompt name as a module header. U+2501. */
export const DEFAULT_HEADER_CHARS = '━';

/** Version stamped into exported module files. */
export const FORMAT_VERSION = 1;

/** `type` field of our export envelope. */
export const EXPORT_TYPE = 'prompt_module';

/** Fields copied from an incoming member onto an existing prompt during an update. */
export const SYNCED_PROMPT_FIELDS = [
    'name',
    'content',
    'role',
    'system_prompt',
    'injection_position',
    'injection_depth',
    'injection_order',
    'injection_trigger',
    'forbid_overrides',
];

/** Our own CSS classes / attributes. (Named CLS so it never shadows global `CSS`.) */
export const CLS = {
    header: 'pm-header',
    toggle: 'pm-toggle',
    badge: 'pm-badge',
    actions: 'pm-actions',
    hidden: 'pm-collapsed-member',
    unassigned: 'pm-unassigned',
    memberToggle: 'pm-member-toggle',
    decorated: 'pm-decorated',
    memberAttr: 'data-pm-module',
};

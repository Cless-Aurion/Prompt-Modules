/**
 * Prompt Modules — turns the header prompts you already use into real, collapsible,
 * shareable modules in the Chat Completion prompt manager.
 *
 * This extension is purely organisational. It never changes prompt construction,
 * ordering, or what is sent to the AI. See README.md for the design rationale and
 * the SillyTavern behaviours it relies on.
 */

import { ctx } from './src/compat.js';
import { initModel } from './src/modules.js';
import {
    getSettings, invalidatePresetMeta, renameCollapseBucket, forgetCollapseBucket,
} from './src/settings.js';
import { startObserving, apply, setModuleMenuHandler } from './src/collapse.js';
import {
    mountSettingsPanel, mountDeleteModuleInterceptor, mountModuleToggleInterceptor,
    openModuleMenu, closeModuleMenu, renderSettingsPanel,
} from './src/ui.js';
import { log, warn } from './src/log.js';

async function boot() {
    try {
        getSettings();
        await initModel();

        setModuleMenuHandler(openModuleMenu);
        mountSettingsPanel();
        mountDeleteModuleInterceptor();
        mountModuleToggleInterceptor();
        startObserving();

        const { eventSource, eventTypes } = ctx();

        // Collapse state is keyed per preset, and the whole panel is rebuilt on a
        // preset switch, so re-apply once the switch has settled.
        const refresh = () => {
            closeModuleMenu();
            invalidatePresetMeta();   // module links/exclusions are per preset
            apply();
            renderSettingsPanel();
        };
        eventSource.on(eventTypes.OAI_PRESET_CHANGED_AFTER, refresh);
        eventSource.on(eventTypes.CHATCOMPLETION_SOURCE_CHANGED, refresh);
        eventSource.on(eventTypes.SETTINGS_UPDATED, apply);

        // Collapse state is filed under the preset's name, so a rename has to
        // carry it across or every module springs open. Module membership itself
        // lives in the preset's own `extensions` bucket, which core moves for us.
        eventSource.on(eventTypes.PRESET_RENAMED, ({ apiId, oldName, newName } = {}) => {
            if (apiId && apiId !== 'openai') return;
            renameCollapseBucket(oldName, newName);
            refresh();
        });
        eventSource.on(eventTypes.PRESET_DELETED, ({ apiId, name } = {}) => {
            if (apiId && apiId !== 'openai') return;
            forgetCollapseBucket(name);
        });

        log('ready');
    } catch (err) {
        warn('failed to start', err);
    }
}

jQuery(async () => {
    const { eventSource, eventTypes } = ctx();
    // APP_READY is in the emitter's auto-fire set, so a late listener still runs.
    eventSource.on(eventTypes.APP_READY, boot);
});

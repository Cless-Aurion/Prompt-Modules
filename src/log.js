import { MODULE_NAME } from './constants.js';

const PREFIX = `[${MODULE_NAME}]`;

export const log = (...args) => console.log(PREFIX, ...args);
export const debug = (...args) => console.debug(PREFIX, ...args);
export const warn = (...args) => console.warn(PREFIX, ...args);
export const error = (...args) => console.error(PREFIX, ...args);

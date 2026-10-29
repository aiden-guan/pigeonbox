/**
 * @pigeonbox/api-contract — the one canonical definition of the protocol between
 * the extension and a PigeonBox server (packages/server). Both build from these
 * schemas. This package must stay dependency-light (zod + @pigeonbox/shared)
 * and must never import server code.
 */
export * from './protocol.js';
export * from './capabilities.js';
export * from './errors.js';
export * from './ai.js';
export * from './account.js';
export * from './auth.js';
export * from './common.js';
export * from './connections.js';
export * from './mail.js';
export * from './research.js';
export * from './ask-limits.js';
export * from './calendar.js';
export * from './relationships.js';
export * from './automation.js';
export * from './team.js';
export * from './documents.js';
export * from './notifications.js';
export * from './overview.js';
export * from './routes.js';

export * from './memory.js';

export * from './compose.js';

export * from './client-config.js';

export * from './tasks.js';

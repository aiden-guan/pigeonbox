/**
 * The bundle's `zod`: every `import … from 'zod'` resolves here (see
 * zodWithoutEval in vite.config.ts), so JIT is off before any schema is built.
 */
import { config } from 'zod';

config({ jitless: true });

export * from 'zod';
export { z, z as default } from 'zod';

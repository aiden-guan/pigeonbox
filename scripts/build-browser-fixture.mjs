import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const outputDir = process.env.PIGEONBOX_BROWSER_EXTENSION_PATH || 'apps/extension/dist';

// Test-only entries in the ignored working build. Release packaging uses temporary staging.
const fixtures = [
  { entry: 'tests/browser/tracking-runtime.ts', name: 'browser-fixture' },
  { entry: 'tests/browser/brain-runtime.ts', name: 'brain-fixture' },
];

for (const fixture of fixtures) {
  await build({
    entryPoints: [fixture.entry],
    outfile: resolve(outputDir, `${fixture.name}.js`),
    bundle: true,
    format: 'iife',
    alias: Object.fromEntries(
      ['shared', 'gmail', 'tracking'].map((name) => [`@pigeonbox/${name}`, resolve(`packages/${name}/src`)]),
    ),
    plugins: [
      {
        name: 'inline-css',
        setup(builder) {
          builder.onResolve({ filter: /\.css\?inline$/ }, (args) => ({
            path: resolve(dirname(args.importer), args.path.replace(/\?inline$/, '')),
            namespace: 'inline-css',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'inline-css' }, async (args) => ({
            contents: await readFile(args.path, 'utf8'),
            loader: 'text',
          }));
        },
      },
    ],
  });
  await writeFile(
    resolve(outputDir, `${fixture.name}.html`),
    `<!doctype html><html><body><script src="${fixture.name}.js"></script></body></html>`,
  );
}

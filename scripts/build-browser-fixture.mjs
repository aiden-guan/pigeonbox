import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

// Test-only entry in the ignored dev build. Release packaging rebuilds dist-release.
await build({
  entryPoints: ['tests/browser/tracking-runtime.ts'],
  outfile: 'apps/extension/dist/browser-fixture.js',
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
  'apps/extension/dist/browser-fixture.html',
  '<!doctype html><html><body><script src="browser-fixture.js"></script></body></html>',
);

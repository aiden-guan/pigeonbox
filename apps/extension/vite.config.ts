import { defineConfig, loadEnv, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import react from '@vitejs/plugin-react';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { viteStaticCopy } from 'vite-plugin-static-copy';

function keepSingleOnnxWasm(): Plugin {
  return {
    name: 'keep-single-onnx-wasm',
    generateBundle(_options, bundle) {
      for (const name of Object.keys(bundle)) {
        if (name.startsWith('assets/') && name.includes('ort-wasm')) delete bundle[name];
      }
    },
  };
}

/** Extension pages reject CORS module loads (`crossorigin`). */
function extensionPages(): Plugin {
  return {
    name: 'extension-pages',
    transformIndexHtml(html) {
      return html.replace(/<script\b[^>]*>|<link\b[^>]*>/gi, (tag) => {
        if (/^<link\b/i.test(tag) && /https?:/i.test(tag)) return tag;
        return tag.replace(/ crossorigin(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/g, '');
      });
    },
  };
}

/**
 * Chrome refuses extension URLs that contain `..`. Nested HTML such as
 * `src/settings/index.html` otherwise points its module script at
 * `../../assets/...`, which Chrome replaces with an error page and then
 * parses as a classic script.
 */
function flattenExtensionHtml(): Plugin {
  return {
    name: 'flatten-extension-html',
    apply: 'build',
    enforce: 'post',
    async writeBundle(output) {
      const outDir = output.dir;
      if (!outDir) return;
      const pages: Array<[string, string]> = [
        ['src/settings/index.html', 'settings.html'],
        ['src/onboarding/index.html', 'onboarding.html'],
        ['src/workspace/index.html', 'workspace.html'],
        ['src/sidepanel/index.html', 'sidepanel.html'],
      ];
      for (const [from, to] of pages) {
        const sourcePath = resolve(outDir, from);
        let html: string;
        try {
          html = await readFile(sourcePath, 'utf8');
        } catch {
          continue;
        }
        const rootHtml = html.replace(/(src|href)="(?:\.\.\/)+/g, '$1="./');
        const legacyHtml = html.replace(/(src|href)="(?:\.\.\/)+assets\//g, '$1="/assets/');
        await writeFile(resolve(outDir, to), rootHtml);
        await writeFile(sourcePath, legacyHtml);
      }
    },
  };
}

/**
 * `PIGEONBOX_RELEASE=1` builds what ships to the Chrome Web Store and GitHub
 * Releases: no source maps, no experimental features, and no machine-local
 * `tracker-config.json` (a developer's personal tracker token).
 */
const release = process.env.PIGEONBOX_RELEASE === '1';
/** Release builds go to their own folder so the unpacked dev build in dist/ is left alone. */
const outDir = process.env.PIGEONBOX_OUT_DIR || (release ? 'dist-release' : 'dist');
if (release) process.env.VITE_PIGEONBOX_EXPERIMENTAL = 'false';
/** Source builds call the local `npm run dev:reload` helper; release builds never do. */
if (release) process.env.VITE_PIGEONBOX_DEV_REBUILD_URL = '';
else process.env.VITE_PIGEONBOX_DEV_REBUILD_URL ??= 'http://127.0.0.1:5199';

/** Files that must never ship even if they sit in public/ on a developer machine. */
const RELEASE_EXCLUDED = ['tracker-config.json'];

function releaseHygiene(): Plugin {
  return {
    name: 'pigeonbox-release-hygiene',
    apply: 'build',
    async writeBundle(output) {
      if (!output.dir) return;
      // Preserve the canonical PNG in source; ship only its lossless WebP counterpart.
      await rm(resolve(output.dir, "brand/pigeon-sprites.png"), { force: true });
      if (!release) return;
      await Promise.all(RELEASE_EXCLUDED.map((file) => rm(resolve(output.dir!, file), { force: true })));
    },
  };
}

/**
 * Chrome derives an extension's ID from the manifest `key`, or from the folder
 * path when there is none. Setting `PIGEONBOX_EXTENSION_KEY` (the store item's
 * public key: Developer Dashboard → Package → View public key) gives the
 * unpacked dev build the same ID as the Chrome Web Store item, so Cloud sign-in
 * redirects and ID allowlists behave the same locally. Release builds never
 * carry it: the store assigns its own key.
 */
function extensionKey(mode: string): string | undefined {
  if (release) return undefined;
  const raw = process.env.PIGEONBOX_EXTENSION_KEY ?? loadEnv(mode, __dirname, 'PIGEONBOX_').PIGEONBOX_EXTENSION_KEY;
  const key = raw
    ?.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '');
  if (!key) return undefined;
  const der = Buffer.from(key, 'base64');
  if (der.length < 100 || der.toString('base64') !== key) {
    throw new Error('PIGEONBOX_EXTENSION_KEY is not a base64 public key. Copy it from Developer Dashboard → Package → View public key.');
  }
  return key;
}

/** The extension ID Chrome derives from a manifest key. */
function extensionIdFromKey(key: string): string {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

function manifestTransform(mode: string) {
  const key = extensionKey(mode);
  if (key) console.log(`[pigeonbox] Unpacked build uses the store extension ID ${extensionIdFromKey(key)}`);
  return (content: string) => (key ? JSON.stringify({ ...JSON.parse(content), key }, null, 2) + '\n' : content);
}

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [
    react(),
    extensionPages(),
    flattenExtensionHtml(),
    keepSingleOnnxWasm(),
    releaseHygiene(),
    ...(mode !== 'content'
      ? [
          viteStaticCopy({
            targets: [
              { src: 'manifest.json', dest: '.', transform: manifestTransform(mode) },
              { src: 'public/icons/*', dest: 'icons' },
              {
                src: '../../node_modules/@inboxsdk/core/pageWorld.js',
                dest: 'inboxsdk',
              },
              {
                src: '../../node_modules/@inboxsdk/core/background.js',
                dest: 'inboxsdk',
              },
              {
                src: '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm',
                dest: 'ort',
              },
              {
                src: '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs',
                dest: 'ort',
              },
            ],
          }),
        ]
      : []),
  ],
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: !release,
    modulePreload: false,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background/index.ts'),
        content: resolve(__dirname, 'src/content/index.ts'),
        mainWorld: resolve(__dirname, 'src/main-world/index.ts'),
        sidepanel: resolve(__dirname, 'src/sidepanel/index.html'),
        workspace: resolve(__dirname, 'src/workspace/index.html'),
        settings: resolve(__dirname, 'src/settings/index.html'),
        onboarding: resolve(__dirname, 'src/onboarding/index.html'),
        offscreen: resolve(__dirname, 'offscreen.html'),
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === 'background') return 'background.js';
          if (chunk.name === 'content') return 'gmail.js';
          if (chunk.name === 'mainWorld') return 'main-world.js';
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  resolve: {
    alias: {
      '@pigeonbox/shared': resolve(__dirname, '../../packages/shared/src'),
      '@pigeonbox/gmail': resolve(__dirname, '../../packages/gmail/src'),
      '@pigeonbox/mailbox': resolve(__dirname, '../../packages/mailbox/src'),
      '@pigeonbox/ai': resolve(__dirname, '../../packages/ai/src'),
      '@pigeonbox/search': resolve(__dirname, '../../packages/search/src'),
      '@pigeonbox/agent': resolve(__dirname, '../../packages/agent/src'),
      '@pigeonbox/tracking': resolve(__dirname, '../../packages/tracking/src'),
      '@pigeonbox/api-contract': resolve(__dirname, '../../packages/api-contract/src'),
      '@pigeonbox/cloud-client': resolve(__dirname, '../../packages/cloud-client/src'),
      '@pigeonbox/core': resolve(__dirname, '../../packages/core/src'),
    },
  },
  ...(mode === 'content'
    ? {
        build: {
          outDir,
          emptyOutDir: false,
          sourcemap: !release,
          rollupOptions: {
            input: resolve(__dirname, 'src/content/index.ts'),
            output: {
              format: 'iife' as const,
              inlineDynamicImports: true,
              entryFileNames: 'gmail.js',
            },
          },
        },
      }
    : {}),
}));

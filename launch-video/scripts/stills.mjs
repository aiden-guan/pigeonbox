// Render review stills: node scripts/stills.mjs <outDir> <frame> [frame...]
import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';
import path from 'node:path';

const [outDir, ...frames] = process.argv.slice(2);
const serveUrl = await bundle({ entryPoint: path.resolve('src/index.ts') });
const composition = await selectComposition({ serveUrl, id: 'PigeonBoxLaunch' });
for (const f of frames) {
  const frame = Number(f);
  await renderStill({ serveUrl, composition, frame, output: path.join(outDir, `f${String(frame).padStart(4, '0')}.jpg`), imageFormat: 'jpeg', jpegQuality: 80, scale: 0.5 });
  console.log('frame', frame);
}

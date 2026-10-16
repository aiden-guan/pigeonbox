#!/usr/bin/env node
/**
 * Check an exported .eml or raw MIME file for the outbound tracking pixel.
 *
 *   npm run verify:tracking -- path/to/message.eml
 *
 * This does not call Gmail or the tracker. It only reads the file you pass.
 */
import { readFileSync } from 'node:fs';
import { inspectTrackingMime } from './lib/tracking-mime.mjs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run verify:tracking -- path/to/message.eml');
  process.exit(2);
}

const { pixelCount, trackedLinks, trackingIds } = inspectTrackingMime(readFileSync(file));

if (!pixelCount) {
  console.log('Tracking pixel found: NO');
  process.exitCode = 1;
} else {
  console.log('Tracking pixel found: YES');
  console.log(`Tracking ID: ${trackingIds.join(', ')}`);
  console.log(`Pixel count: ${pixelCount}`);
  console.log(`Tracked links: ${trackedLinks}`);
}

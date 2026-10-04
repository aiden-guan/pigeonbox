/** Port protocol between the side panel and the background for streamed Ask Pigeon. Types only, so pages can import it. */
import type { AskPigeonResponse, AskStreamEvent } from '@pigeonbox/api-contract';

export const ASK_STREAM_PORT = 'pigeonbox-ask-stream';

export type AskStreamPortMessage =
  | { type: 'event'; event: AskStreamEvent }
  | { type: 'fallback'; result: { ok: true; data: AskPigeonResponse } | { ok: false; code: string; reason: string } }
  | { type: 'failed'; code: string; reason: string };

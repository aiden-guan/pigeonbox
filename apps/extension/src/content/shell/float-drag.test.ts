import { describe, expect, it } from 'vitest';
import { SNAP_GAP, snapPos } from './float-drag';

const viewport = { width: 1200, height: 800 };
const card = { width: 380, height: 600 };

describe('snapPos', () => {
  it('snaps to the right edge when dropped near it', () => {
    expect(snapPos({ right: 30, top: 120 }, card, viewport)).toEqual({ right: SNAP_GAP, top: 120 });
  });

  it('snaps to the left edge when dropped near it', () => {
    expect(snapPos({ right: 1200 - 380 - 20, top: 120 }, card, viewport)).toEqual({ right: 1200 - 380 - SNAP_GAP, top: 120 });
  });

  it('snaps into a corner when both axes are near an edge', () => {
    expect(snapPos({ right: 40, top: 800 - 600 - 10 }, card, viewport)).toEqual({ right: SNAP_GAP, top: 800 - 600 - SNAP_GAP });
    expect(snapPos({ right: 20, top: 30 }, card, viewport)).toEqual({ right: SNAP_GAP, top: SNAP_GAP });
  });

  it('leaves a card dropped away from every edge where it is', () => {
    expect(snapPos({ right: 300, top: 100 }, { width: 144, height: 44 }, viewport)).toEqual({ right: 300, top: 100 });
  });

  it('snaps the collapsed pill too', () => {
    expect(snapPos({ right: 300, top: 800 - 44 - 25 }, { width: 144, height: 44 }, viewport)).toEqual({ right: 300, top: 800 - 44 - SNAP_GAP });
  });
});

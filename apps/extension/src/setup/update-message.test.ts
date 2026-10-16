import { describe, expect, it } from 'vitest';
import { updateMessage } from './RunModePanel';

describe('update wording', () => {
  it('names both versions for a required update', () => {
    expect(updateMessage({ required: true, installed: '0.5.8', minimum: '0.6.0', recommended: null })).toBe("You're using PigeonBox 0.5.8. PigeonBox Pro requires 0.6.0 or newer.");
  });
  it('keeps a recommended update a recommendation', () => {
    expect(updateMessage({ required: false, installed: '0.6.0', minimum: null, recommended: '0.6.1' })).toBe("You're using PigeonBox 0.6.0. Version 0.6.1 is recommended.");
  });
  it('still explains a server refusal that named no version', () => {
    expect(updateMessage({ required: true, installed: '0.5.8', minimum: null, recommended: null })).toBe("You're using PigeonBox 0.5.8. PigeonBox Pro needs a newer version.");
  });
});

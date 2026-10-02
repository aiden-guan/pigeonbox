import { describe, expect, it } from 'vitest';
import { cloudTrackerUrls, trackerIssuer } from './config';

describe('tracker identity', () => {
  it('keys Cloud by its API so a tracker hostname change keeps IDs routable', () => {
    const cloud = { runMode: 'cloud', cloudApiUrl: 'https://api.example.com/', trackerBaseUrl: 'https://self.example' };
    expect(trackerIssuer(cloud)).toBe('cloud:https://api.example.com');
  });

  it('keys a self-hosted tracker by its origin and never mixes it with Cloud', () => {
    expect(trackerIssuer({ runMode: 'local', cloudApiUrl: 'https://api.example.com', trackerBaseUrl: 'https://track.example/base/' })).toBe('local:https://track.example');
    expect(trackerIssuer({ runMode: 'local', cloudApiUrl: '', trackerBaseUrl: '' })).toBeNull();
    expect(trackerIssuer({ runMode: 'local', cloudApiUrl: '', trackerBaseUrl: 'javascript:alert(1)' })).toBeNull();
  });

  it('puts the current hosted tracker first, including the loopback development pair', () => {
    expect(cloudTrackerUrls({ cloudApiUrl: 'http://127.0.0.1:8788' })[0]).toBe('http://127.0.0.1:8789');
  });
});

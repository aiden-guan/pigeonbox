import { describe, expect, it } from 'vitest';
import { BUILD_CLOUD_API_URL, cloudTrackerUrls, trackerIssuer, usesHostedTracker } from './config';

const BUILD_HAS_CLOUD = Boolean(BUILD_CLOUD_API_URL);

describe('tracker identity', () => {
  it('keys Cloud by its API so a tracker hostname change keeps IDs routable', () => {
    const cloud = { runMode: 'cloud', cloudApiUrl: 'https://api.example.com/', trackerBaseUrl: 'https://self.example' };
    expect(trackerIssuer(cloud)).toBe('cloud:https://api.example.com');
  });

  it('keys a self-hosted tracker by its origin and never mixes it with Cloud', () => {
    expect(trackerIssuer({ runMode: 'local', localOnly: true, cloudApiUrl: 'https://api.example.com', trackerBaseUrl: 'https://track.example/base/' })).toBe('local:https://track.example');
    expect(trackerIssuer({ runMode: 'local', localOnly: true, cloudApiUrl: '', trackerBaseUrl: '' })).toBeNull();
    expect(trackerIssuer({ runMode: 'local', localOnly: true, cloudApiUrl: '', trackerBaseUrl: 'javascript:alert(1)' })).toBeNull();
  });

  it('puts the current hosted tracker first, including the loopback development pair', () => {
    expect(cloudTrackerUrls({ cloudApiUrl: 'http://127.0.0.1:8788' })[0]).toBe('http://127.0.0.1:8789');
  });

  it('uses the hosted tracker in Free unless local-only or the build has no PigeonBox service', () => {
    expect(usesHostedTracker({ runMode: 'local', localOnly: false, cloudApiUrl: 'https://api.example.com' })).toBe(true);
    expect(trackerIssuer({ runMode: 'local', localOnly: false, cloudApiUrl: 'https://api.example.com', trackerBaseUrl: '' })).toBe('cloud:https://api.example.com');
    expect(usesHostedTracker({ runMode: 'local', localOnly: true, cloudApiUrl: 'https://api.example.com' })).toBe(false);
    expect(usesHostedTracker({ runMode: 'local', localOnly: false, cloudApiUrl: '' })).toBe(BUILD_HAS_CLOUD);
    expect(usesHostedTracker({ runMode: 'cloud', localOnly: true, cloudApiUrl: '' })).toBe(true);
  });
});

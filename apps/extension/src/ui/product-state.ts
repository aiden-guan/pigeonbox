import { trackProductEvent } from './analytics';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CloudState, PigeonBoxCapability, PigeonBoxMode } from '@pigeonbox/core';

/** What the background worker reports about mode, Cloud and capabilities. */
export type ProductState = {
  runMode: PigeonBoxMode;
  cloudAvailable: boolean;
  cloudConsentAt: string | null;
  cloud: CloudState;
  capabilities: PigeonBoxCapability[];
  aiDestination: 'none' | 'this_device' | 'your_provider' | 'pigeonbox_cloud' | 'chatgpt_web';
  experimental: boolean;
  cloudOrigins: string[];
};

export const INITIAL_PRODUCT_STATE: ProductState = {
  runMode: 'local',
  cloudAvailable: false,
  cloudConsentAt: null,
  cloud: { status: 'not_configured', email: null, plan: null, capabilities: [] },
  capabilities: ['ask_inbox'],
  aiDestination: 'none',
  experimental: false,
  cloudOrigins: [],
};

type Reply = { ok?: boolean; reason?: string; state?: ProductState };

function hasRuntime(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.sendMessage);
}

export function sendProductMessage(message: Record<string, unknown>): Promise<Reply | ProductState | undefined> {
  if (!hasRuntime()) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response?: Reply | ProductState) => {
      if (chrome.runtime.lastError) resolve(undefined);
      else resolve(response);
    });
  });
}

/**
 * Mode, Cloud status and capabilities for extension pages. Components check
 * `has('cloud_tracking')` etc. instead of branching on mode or plan.
 */
export function useProductState() {
  const [state, setState] = useState<ProductState>(INITIAL_PRODUCT_STATE);
  const refreshSequence = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    const next = (await sendProductMessage({ type: 'GET_PRODUCT_STATE' })) as ProductState | undefined;
    if (sequence === refreshSequence.current && next && 'runMode' in next) setState(next);
  }, []);

  const invalidate = useCallback(() => { ++refreshSequence.current; }, []);
  useEffect(() => {
    void refresh();
    const changed = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.settings || changes.cloudSession || changes.cloudState) void refresh();
    };
    chrome.storage?.onChanged?.addListener(changed);
    return () => { invalidate(); chrome.storage?.onChanged?.removeListener(changed); };
  }, [refresh, invalidate]);

  const run = useCallback(async (message: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const reply = (await sendProductMessage(message)) as Reply | undefined;
      if (reply?.state) setState(reply.state);
      if (reply && reply.ok === false) setError(reply.reason || 'That did not work.');
      return reply;
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    state,
    busy,
    error,
    refresh,
    has: (capability: PigeonBoxCapability) => state.capabilities.includes(capability),
    useLocal: () => { trackProductEvent('local_selected'); return run({ type: 'SET_RUN_MODE', mode: 'local' }); },
    useCloud: (consent: boolean) => { if (consent) trackProductEvent('cloud_selected'); return run({ type: 'SET_RUN_MODE', mode: 'cloud', consent }); },
    /** Call from a click handler: Chrome only shows permission prompts during a user gesture. */
    signIn: async () => {
      trackProductEvent('cloud_signin_started');
      if (typeof chrome !== 'undefined' && chrome.permissions?.request) {
        const granted = await chrome.permissions
          .request({ permissions: ['identity'], origins: state.cloudOrigins })
          .catch(() => false);
        if (!granted) {
          setError('PigeonBox needs permission to open the sign-in window and reach PigeonBox Cloud.');
          return undefined;
        }
      }
      const reply = await run({ type: 'CLOUD_SIGN_IN' });
      if (reply?.ok) trackProductEvent('cloud_signin_completed', { outcome: 'success' });
      return reply;
    },
    signOut: () => run({ type: 'CLOUD_SIGN_OUT' }),
    recheck: () => run({ type: 'CLOUD_REFRESH' }),
    billing: (kind: 'checkout' | 'portal') => run({ type: 'CLOUD_BILLING', kind }),
  };
}

export type ProductControls = ReturnType<typeof useProductState>;

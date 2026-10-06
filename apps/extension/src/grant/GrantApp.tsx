import { useState } from 'react';
import { useAppearance } from '../ui/appearance';
import { Brand, Pigeon } from '../ui/Pigeon';

const ORIGIN_PATTERN = /^(https:\/\/[a-z0-9.-]+(:\d+)?|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)\/\*$/i;

/** Origins named in this page's address, limited to the shapes the worker sends. */
function requestedOrigins(): string[] {
  const raw = new URLSearchParams(location.search).get('origins') ?? '';
  return raw.split(',').filter((origin) => ORIGIN_PATTERN.test(origin)).slice(0, 4);
}

/**
 * Chrome only shows a permission prompt after a click on an extension page.
 * The dashboard asks the worker to open this window when something it set up
 * (a tracker or AI provider address, or PigeonBox Cloud) needs access to a new site.
 */
export function GrantApp() {
  useAppearance();
  const origins = requestedOrigins();
  const [result, setResult] = useState<'granted' | 'denied' | null>(null);

  async function allow() {
    const granted = await chrome.permissions.request({ origins }).catch(() => false);
    setResult(granted ? 'granted' : 'denied');
    if (granted) setTimeout(() => window.close(), 900);
  }

  return (
    <div className="gi-app flex min-h-full items-center justify-center px-6 py-10">
      <div className="w-full max-w-[360px]">
        <Brand />
        <div className="mt-6"><Pigeon state={result === 'granted' ? 'success' : result === 'denied' ? 'attention' : 'idle'} size={40} /></div>
        <h1 className="gi-display mt-4 text-[26px]">Allow access</h1>
        {origins.length ? (
          <>
            <p className="gi-muted mt-3 text-sm">PigeonBox needs to reach these addresses for what you just set up:</p>
            <ul className="mt-3 space-y-1 text-sm">
              {origins.map((origin) => <li key={origin}><code>{origin.replace(/\/\*$/, '')}</code></li>)}
            </ul>
            <div className="mt-6 flex flex-wrap gap-2">
              <button type="button" className="gi-btn" onClick={() => void allow()} disabled={result === 'granted'}>
                {result === 'granted' ? 'Allowed' : 'Allow'}
              </button>
              <button type="button" className="gi-btn gi-btn-ghost" onClick={() => window.close()}>Not now</button>
            </div>
            {result === 'denied' ? <p className="gi-warn mt-3 text-xs" role="alert">Chrome did not grant access. The setting is saved but will not work until access is allowed.</p> : null}
          </>
        ) : (
          <p className="gi-muted mt-3 text-sm">There is nothing to allow. You can close this window.</p>
        )}
      </div>
    </div>
  );
}

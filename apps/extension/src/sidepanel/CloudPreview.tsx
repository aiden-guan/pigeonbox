import { SELF_HOSTING_GUIDE_URL } from '../config';
import { useEffect, useState } from 'react';
import type { ProductControls } from '../ui/product-state';
import { RunModePanel } from '../setup/RunModePanel';

export function CloudPreview({ product, compact = false }: { product: ProductControls; compact?: boolean }) {
  const [dismissed, setDismissed] = useState(true);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    void chrome.storage.local
      .get('cloudPreviewDismissed')
      .then((value) => setDismissed(Boolean(value.cloudPreviewDismissed)));
  }, []);
  if (compact && dismissed) return null;
  return (
    <section className="gi-cloud-preview">
      <div className="gi-cloud-section-head">
        <strong>Your PigeonBox server</strong>
        {compact ? (
          <button
            className="gi-text-btn"
            type="button"
            aria-label="Dismiss server preview"
            onClick={() => {
              setDismissed(true);
              void chrome.storage.local.set({ cloudPreviewDismissed: true });
            }}
          >
            Dismiss
          </button>
        ) : null}
      </div>
      <h2>Works while Gmail is closed.</h2>
      <p>
        With a connected Google account, your PigeonBox server keeps follow-ups current and prepares drafts, briefings
        and meeting context.
      </p>
      <p className="gi-muted">Sending and invitations require your approval.</p>
      {product.state.cloudAvailable ? (
        <button
          type="button"
          className="gi-btn gi-btn-ghost"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          See how it works
        </button>
      ) : (
        <><p className="gi-muted">No server is configured. PigeonBox keeps working on this computer.</p><a className="gi-btn gi-btn-ghost" href={SELF_HOSTING_GUIDE_URL} target="_blank" rel="noreferrer">Run your own server ↗</a></>
      )}
      {expanded || (!compact && product.state.runMode === 'cloud') ? <RunModePanel product={product} /> : null}
      {product.error ? (
        <p role="alert" className="gi-danger">
          {product.error}
        </p>
      ) : null}
    </section>
  );
}

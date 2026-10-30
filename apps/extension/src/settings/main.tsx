import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import '../ui/dispatch.css';
import '../ui/system.css';
import { AiSetupApp } from './AiSetupApp';
import { SettingsApp } from './SettingsApp';

// With a PigeonBox server whose dashboard can reach this build, Settings live
// there and this page forwards to it. Otherwise (no server, the usual case) this
// page is Settings. AI setup (`?here=ai`) always needs an extension page, and
// `?here` keeps the in-extension page for development and offline use.
const here = new URLSearchParams(location.search).get('here');

if (here === null) {
  chrome.runtime.sendMessage({ type: 'GET_DASHBOARD_URL', section: location.hash.slice(1) || 'general' }, (reply?: { url?: string }) => {
    if (chrome.runtime.lastError || !reply?.url) {
      render(<SettingsApp />);
      return;
    }
    location.replace(reply.url);
  });
} else {
  render(here === 'ai' ? <AiSetupApp /> : <SettingsApp />);
}

function render(node: React.ReactNode) {
  createRoot(document.getElementById('root')!).render(<React.StrictMode>{node}</React.StrictMode>);
}

import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import '../ui/dispatch.css';
import '../ui/system.css';
import { AiSetupApp } from './AiSetupApp';
import { SettingsApp } from './SettingsApp';

// Settings live on the PigeonBox dashboard. This page forwards there, except
// for AI setup (`?here=ai`), which needs an extension page, and the full
// in-extension page (`?here`), kept for development and offline use.
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

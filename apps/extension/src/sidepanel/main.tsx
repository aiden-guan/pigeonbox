import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import '../ui/dispatch.css';
import { SidePanelApp } from './SidePanelApp';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SidePanelApp />
  </React.StrictMode>,
);

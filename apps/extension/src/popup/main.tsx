import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import '../ui/dispatch.css';
import { PopupApp } from './PopupApp';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PopupApp />
  </React.StrictMode>,
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import '../ui/dispatch.css';
import '../ui/system.css';
import { GrantApp } from './GrantApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GrantApp />
  </StrictMode>,
);

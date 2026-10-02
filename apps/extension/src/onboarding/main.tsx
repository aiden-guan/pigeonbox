import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import '../ui/dispatch.css';
import { OnboardingApp } from './OnboardingApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <OnboardingApp />
  </StrictMode>,
);

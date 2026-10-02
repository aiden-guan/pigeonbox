import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import '../ui/dispatch.css';
import '../ui/system.css';
import { PigeonBoxWorkspace } from './PigeonBoxWorkspace';
createRoot(document.getElementById('root')!).render(<React.StrictMode><PigeonBoxWorkspace /></React.StrictMode>);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  // index.html owns this element; if it is missing the build is broken, and a
  // loud failure here is far easier to diagnose than a silently blank page.
  throw new Error('MeetFlow could not start: #root is missing from index.html.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

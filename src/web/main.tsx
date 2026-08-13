import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App.js';
import { AgentProvider } from './agent.js';

if (import.meta.env.DEV) {
  import("react-grab");
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    {/* Above `App` so the header's picker and the trace's assistant marks read
        one value — see `AgentProvider`. */}
    <AgentProvider>
      <App />
    </AgentProvider>
  </StrictMode>,
);

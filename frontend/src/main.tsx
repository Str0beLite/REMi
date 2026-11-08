import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SpacetimeDBProvider } from 'spacetimedb/react';
import './index.css';
import App from './App.tsx';
import { connectionBuilder } from './stdb';

// Built once at module load, so StrictMode's double render doesn't open two connections.
const builder = connectionBuilder();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SpacetimeDBProvider connectionBuilder={builder}>
      <App />
    </SpacetimeDBProvider>
  </StrictMode>,
);

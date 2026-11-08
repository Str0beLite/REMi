import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SpacetimeDBProvider } from 'spacetimedb/react';
import './index.css';
import App from './App.tsx';
import { connectionBuilder, connectToCluster } from './stdb';
import { clusterStatus } from './nodes/setupApi';
import { withoutClaim } from './admin/claim';

// A machine in a cluster connects to the cluster's database (#83). Its `remi up` link's one-time code is for the unused
// local database, so drop it rather than show onboarding again. The builder is made once, so StrictMode's double render
// doesn't open two connections.
void clusterStatus().then(cluster => {
  if (cluster) {
    connectToCluster(cluster.url, cluster.db);
    history.replaceState(history.state, '', withoutClaim(location.href));
  }
  const builder = connectionBuilder();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <SpacetimeDBProvider connectionBuilder={builder}>
        <App />
      </SpacetimeDBProvider>
    </StrictMode>,
  );
});

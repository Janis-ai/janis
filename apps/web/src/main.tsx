import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { applyTheme, currentTheme } from './lib/theme';
import { installErrorReporter } from './lib/errorReporter';
import { installTranslateGuard } from './lib/translateGuard';
import './styles.css';

applyTheme(currentTheme());
installErrorReporter();
installTranslateGuard();

// Registered here (not the plugin's injected registerSW.js) so a rejected
// registration — crawlers expose navigator.serviceWorker but refuse
// register() — is swallowed instead of surfacing as an error report.
if ('serviceWorker' in navigator) {
  // A precached shell keeps serving the old bundle after a deploy until a
  // load happens under the NEW worker — users re-report fixed bugs off
  // stale code. When an update claims this page, reload once so it runs
  // the matching bundle. First-ever install is exempt: there was no prior
  // controller, so nothing stale was ever served.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let swReloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || swReloaded) return;
    swReloaded = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  });
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);

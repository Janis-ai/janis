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
    navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then((reg) => {
        // register() only checks for a new sw.js on page load — a tab left
        // open for days runs the stale bundle forever (and re-reports bugs
        // already fixed). Poll hourly + on tab-visible so a deploy's new
        // worker installs → controllerchange → one reload → fresh code.
        const update = () => reg.update().catch(() => {});
        setInterval(update, 60 * 60 * 1000);
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden) update();
        });
      })
      .catch(() => {});
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

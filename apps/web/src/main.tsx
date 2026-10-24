import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { applyTheme, currentTheme } from './lib/theme';
import { installErrorReporter } from './lib/errorReporter';
import './styles.css';

applyTheme(currentTheme());
installErrorReporter();

// Registered here (not the plugin's injected registerSW.js) so a rejected
// registration — crawlers expose navigator.serviceWorker but refuse
// register() — is swallowed instead of surfacing as an error report.
if ('serviceWorker' in navigator) {
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

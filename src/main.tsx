import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import './local/overlay.css';
import './local/forms.css';
import { configureDataBase } from './data/load';
import App from './App';
import OverlayApp from './overlay/OverlayApp';
import { ErrorBoundary } from './components/ErrorBoundary';

const isOverlay = location.hash === '#/overlay';
if (isOverlay) document.body.classList.add('overlay-window');
const render = () =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary>{isOverlay ? <OverlayApp /> : <App />}</ErrorBoundary>
    </StrictMode>,
  );

if (isOverlay && window.brawlAPI?.getDataStatus) {
  window.brawlAPI.onDataActivated(() => location.reload());
  void configureDataBase().then(render);
} else render();

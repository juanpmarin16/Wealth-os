
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import MarketDataTest from './data/MarketDataTest';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MarketDataTest />
  </StrictMode>,
);

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { bootstrapTheme } from './lib/theme';

const stopTheme = bootstrapTheme();
if (import.meta.hot) import.meta.hot.dispose(stopTheme);
const mount = () => ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
// Canvas measurements are synchronous; load its face before the first saved layer
// is measured. fonts.ready alone does not load fonts that have not been used yet.
void Promise.all([
  document.fonts.load('400 12px "Geist Variable"'),
  document.fonts.load('600 32px "Inter Variable"'),
]).then(mount, mount);

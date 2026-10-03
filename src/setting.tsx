import React from 'react';
import ReactDOM from 'react-dom/client';
import Settings from './components/Settings';
import { bootstrapTheme } from './lib/theme';
import './styles.css';

const stopTheme = bootstrapTheme();
if (import.meta.hot) import.meta.hot.dispose(stopTheme);
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><div className="settings-page"><Settings /></div></React.StrictMode>);

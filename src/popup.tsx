import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Icon, type IconName } from './components/Icon';
import type { CaptureMode } from './lib/capture-store';
import Settings from './components/Settings';
import { bootstrapTheme } from './lib/theme';
import './styles.css';

const MODES: { id: CaptureMode; icon: IconName; label: string }[] = [
  { id: 'area', icon: 'radius', label: 'Area' },
  { id: 'visible', icon: 'visible', label: 'Display' },
  { id: 'full', icon: 'page', label: 'Full page' },
];

function Popup() {
  const [busy, setBusy] = useState<CaptureMode | null>(null);
  const [selected, setSelected] = useState<CaptureMode>('full');
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const extension = typeof globalThis.chrome !== 'undefined' && Boolean(globalThis.chrome.runtime?.id);

  async function capture(mode: CaptureMode) {
    setSelected(mode);
    if (!extension) {
      setError('Load the dist folder as unpacked extension to capture.');
      return;
    }
    setError('');
    setBusy(mode);
    
    let closeTimer: ReturnType<typeof window.setTimeout> | undefined;
    try {
      const promise = chrome.runtime.sendMessage({ type: 'IMAGESHOT_CAPTURE', mode });
      // popup steps aside so it doesn't capture itself
      closeTimer = window.setTimeout(() => window.close(), 150);
      const result = await promise;
      
      if (!result?.ok) {
        window.clearTimeout(closeTimer);
        setError(result?.error || 'Capture failed. Try on a regular webpage.');
        setBusy(null);
      } else {
        window.close();
      }
    } catch (e) {
      window.clearTimeout(closeTimer);
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      setBusy(null);
    }
  }

  if (settingsOpen) return <Settings compact onClose={() => setSettingsOpen(false)} />;

  return (
    <div className="w-fit bg-surface text-ink" data-testid="capture-popup">
      <div className="inline-flex items-center gap-1 p-1 rounded-[13px] bg-surface border border-line shadow-[0_4px_16px_rgba(0,0,0,.10),0_1px_2px_rgba(0,0,0,.06)]">
        
        {MODES.map((mode) => {
          const isSelected = selected === mode.id;
          const running = busy === mode.id;
          return (
            <button
              key={mode.id}
              onClick={() => capture(mode.id)}
              disabled={!!busy}
              aria-pressed={isSelected}
              aria-busy={running}
              className={`flex flex-col items-center justify-center gap-1 min-w-[72px] px-3 py-[7px] rounded-[9px] transition-colors duration-150 disabled:cursor-wait disabled:opacity-60
                ${isSelected ? 'bg-field text-ink' : 'text-ink-2 hover:text-ink hover:bg-field'}
              `}
            >
              <Icon name={running ? 'reset' : mode.icon} size={18} strokeWidth={isSelected ? 1.9 : 1.6} className={running ? 'animate-spin' : ''} />
              <span className="text-[11px] font-medium leading-none tracking-[-0.01em]">{running ? 'Capturing' : mode.label}</span>
            </button>
          );
        })}

        <div className="w-px h-[28px] bg-line mx-0.5" />

        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          disabled={!!busy}
          className="flex flex-col items-center justify-center gap-1 min-w-[56px] px-2 py-[7px] rounded-[9px] text-ink-2 hover:text-ink hover:bg-field transition-colors"
        >
          <Icon name="setting" size={18} strokeWidth={1.6} />
          <span className="text-[11px] font-medium leading-none">Settings</span>
        </button>
      </div>

      {error && (
        <p role="alert" className="max-w-[320px] px-3 py-2 rounded-[8px] bg-surface border border-line text-danger text-[11px] leading-[1.5]">
          {error}
        </p>
      )}
    </div>
  );
}

const stopTheme = bootstrapTheme();
if (import.meta.hot) import.meta.hot.dispose(stopTheme);
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Popup /></React.StrictMode>);

import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Icon, type IconName } from './components/Icon';
import type { CaptureMode } from './lib/capture-store';
import { readCaptureDestination, writeCaptureDestination, type CaptureDestination } from './extension/preferences';
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
  const extension = typeof globalThis.chrome !== 'undefined' && Boolean(globalThis.chrome.runtime?.id);

  // DEFAULT = PINNED - so preview shows on same page, not editor
  useEffect(() => { 
    readCaptureDestination().then((d) => {
      if (!d) {
        // first time - set to panel and save it
        writeCaptureDestination('panel').catch(()=>{});
      }
    }).catch(()=>{});
    // force default to panel so it never goes to editor
    writeCaptureDestination('panel').catch(()=>{});
  }, []);

  async function capture(mode: CaptureMode) {
    setSelected(mode);
    if (!extension) {
      setError('Load the dist folder as unpacked extension to capture.');
      return;
    }
    // Ensure it stays pinned - prevent going to editor
    await writeCaptureDestination('panel').catch(()=>{});
    
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

  function openSetting() {
    // Just setting - do not touch destination logic
    if (extension && chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    }
  }

  return (
    <div className="w-fit bg-transparent">
      {/* CLEAN HORIZONTAL BAR */}
      <div className="inline-flex items-center gap-1 p-1 rounded-[13px] bg-white border border-black/[0.08] shadow-[0_4px_16px_rgba(0,0,0,.10),0_1px_2px_rgba(0,0,0,.06)]">
        
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
                ${isSelected ? 'bg-[#EFEFF0] text-[#1D1D1F]' : 'text-[#8E8E93] hover:text-[#1D1D1F] hover:bg-black/[0.04]'}
              `}
            >
              <Icon name={running ? 'reset' : mode.icon} size={18} strokeWidth={isSelected ? 1.9 : 1.6} className={running ? 'animate-spin' : ''} />
              <span className="text-[11px] font-medium leading-none tracking-[-0.01em]">{running ? 'Capturing' : mode.label}</span>
            </button>
          );
        })}

        <div className="w-px h-[28px] bg-black/[0.08] mx-0.5" />

        {/* LAST OPTION = ONLY SETTING */}
        <button
          onClick={openSetting}
          className="flex flex-col items-center justify-center gap-1 min-w-[56px] px-2 py-[7px] rounded-[9px] text-[#8E8E93] hover:text-[#1D1D1F] hover:bg-black/[0.04] transition-colors"
        >
          <Icon name="setting" size={18} strokeWidth={1.6} />
          <span className="text-[11px] font-medium leading-none">Setting</span>
        </button>
      </div>

      {error && (
        <p className="max-w-[320px] px-3 py-2 rounded-[8px] bg-[#fff7f5] border border-[#f1d3cc] text-[#9b493b] text-[11px] leading-[1.5]">
          {error}
        </p>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Popup /></React.StrictMode>);
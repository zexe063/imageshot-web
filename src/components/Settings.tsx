import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import {
  readCaptureDestination, writeCaptureDestination, readAutoCopy, writeAutoCopy,
  readFreezeScreen, writeFreezeScreen, readFileFormat, writeFileFormat, readShortcuts, subscribePreferences,
  type CaptureDestination, type FileFormat, type Theme,
} from '../extension/preferences';
import { useTheme } from '../lib/theme';

type Tab = 'appearance' | 'capture' | 'shortcuts' | 'about';
const tabs: { id: Tab; label: string }[] = [
  { id: 'appearance', label: 'Appearance' }, { id: 'capture', label: 'Capture' },
  { id: 'shortcuts', label: 'Shortcuts' }, { id: 'about', label: 'About' },
];
const themes: Theme[] = ['system', 'light', 'dark'];

function Row({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return <div className="settings-row"><div className="min-w-0"><div className="settings-row-label">{label}</div>{description && <p className="settings-row-description">{description}</p>}</div>{children}</div>;
}

function Switch({ label, value, disabled, onChange }: { label: string; value: boolean; disabled: boolean; onChange: (next: boolean) => void }) {
  return <button type="button" role="switch" aria-label={label} aria-checked={value} disabled={disabled} onClick={() => onChange(!value)} className="settings-switch" data-on={value || undefined}><span /></button>;
}

/** Shared by the popup, editor dialog, and browser's extension options entry. */
export default function Settings({ onClose, compact = false }: { onClose?: () => void; compact?: boolean }) {
  const [tab, setTab] = useState<Tab>('appearance');
  const { theme, setTheme } = useTheme();
  const [preferences, setPreferences] = useState({ destination: 'panel' as CaptureDestination, autoCopy: false, freezeScreen: false, fileFormat: 'png' as FileFormat });
  const [shortcuts, setShortcuts] = useState({ area: 'Loading…', display: 'Loading…', full: 'Loading…' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const saveInFlight = useRef(false);
  const extension = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
  const version = extension ? chrome.runtime.getManifest().version : '1.0.0';

  useEffect(() => {
    mounted.current = true;
    let generation = 0;
    async function refresh() {
      const request = ++generation;
      try {
        const [destination, autoCopy, freezeScreen, fileFormat] = await Promise.all([readCaptureDestination(), readAutoCopy(), readFreezeScreen(), readFileFormat()]);
        if (mounted.current && request === generation) setPreferences({ destination, autoCopy, freezeScreen, fileFormat });
      } finally { if (mounted.current) setLoading(false); }
    }
    const refreshShortcuts = () => void readShortcuts().then(value => { if (mounted.current) setShortcuts(value); }).catch(() => {
      if (mounted.current) setShortcuts({ area: 'Unavailable', display: 'Unavailable', full: 'Unavailable' });
    });
    void refresh();
    refreshShortcuts();
    const unsubscribe = subscribePreferences(() => { void refresh(); });
    window.addEventListener('focus', refreshShortcuts);
    return () => { mounted.current = false; unsubscribe(); window.removeEventListener('focus', refreshShortcuts); };
  }, []);

  async function save(action: () => Promise<void>, message: string) {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    setError('');
    setStatus('');
    try {
      await action();
      if (mounted.current) setStatus(message);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? `Could not save: ${cause.message}` : 'Could not save this setting. Try again.');
    } finally { saveInFlight.current = false; if (mounted.current) setSaving(false); }
  }

  async function openBrowserShortcuts() {
    setError('');
    try {
      const url = /Edg\//.test(navigator.userAgent) ? 'edge://extensions/shortcuts' : 'chrome://extensions/shortcuts';
      await chrome.tabs.create({ url });
    } catch { setError('Open your browser’s Extensions page, then choose Keyboard shortcuts.'); }
  }

  const disabled = loading || saving;
  return (
    <section className={`settings-shell ${compact ? 'settings-compact' : ''}`} aria-label="ImageShot settings" onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape' && compact) onClose?.(); }}>
      <header className="settings-header">
        <div className="flex items-center gap-2.5"><span className="grid h-8 w-8 place-items-center rounded-lg bg-accent-soft text-accent-ink"><Icon name="setting" size={19} /></span><h1 className="text-[16px] font-semibold tracking-tight">Settings</h1></div>
        {onClose && <button type="button" aria-label={compact ? 'Back to capture' : 'Close settings'} className="grid h-8 w-8 place-items-center rounded-control text-ink-2 hover:bg-field hover:text-ink" onClick={onClose}><Icon name={compact ? 'chevron' : 'close'} size={18} className={compact ? 'rotate-90' : ''} /></button>}
      </header>
      <div className="settings-layout">
        <nav className="settings-tabs" aria-label="Settings sections">
          {tabs.map(item => <button type="button" key={item.id} aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)}>{item.label}</button>)}
        </nav>
        <div className="settings-content">
          {tab === 'appearance' && <>
            <h2>Theme</h2>
            <div className="settings-themes" role="radiogroup" aria-label="Color theme" onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              if (disabled) return;
              const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
              const index = event.key === 'Home' ? 0 : event.key === 'End' ? themes.length - 1 : (themes.indexOf(theme) + direction + themes.length) % themes.length;
              event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[index]?.focus();
              void save(() => setTheme(themes[index]), 'Theme saved.');
            }}>
              {themes.map(value => <button key={value} type="button" role="radio" aria-checked={theme === value} aria-disabled={disabled || undefined} tabIndex={theme === value ? 0 : -1} onClick={() => { if (!disabled) void save(() => setTheme(value), 'Theme saved.'); }}>
                <span className="settings-preview" data-swatch={value} aria-hidden="true"><span /><span /><span /></span>
                <span className="flex items-center justify-center gap-1.5">{value.charAt(0).toUpperCase() + value.slice(1)}{theme === value && <Icon name="check" size={12} />}</span>
              </button>)}
            </div>
          </>}
          {tab === 'capture' && <>
            <h2>Capture & export</h2>
            <div className="settings-card">
              <Row label="After capture"><select aria-label="After capture" value={preferences.destination} disabled={disabled} onChange={event => void save(() => writeCaptureDestination(event.target.value as CaptureDestination), 'Capture destination saved.')}><option value="panel">Preview panel</option><option value="studio">Editor</option></select></Row>
              <Row label="Freeze screen capture" description="Freeze a frame before selecting an area in videos, GIFs, or animations."><Switch label="Freeze screen capture" value={preferences.freezeScreen} disabled={disabled} onChange={value => void save(() => writeFreezeScreen(value), 'Freeze capture saved.')} /></Row>
              <Row label="Automatically copy capture" description="Copy captures to the clipboard as PNG."><Switch label="Automatically copy capture" value={preferences.autoCopy} disabled={disabled} onChange={value => void save(() => writeAutoCopy(value), 'Clipboard preference saved.')} /></Row>
              <Row label="Default file format"><select aria-label="Default file format" value={preferences.fileFormat} disabled={disabled} onChange={event => void save(() => writeFileFormat(event.target.value as FileFormat), 'Default format saved.')}><option value="png">PNG</option><option value="jpg">JPG</option></select></Row>
            </div>
          </>}
          {tab === 'shortcuts' && <>
            <h2>Capture shortcuts</h2>
            <div className="settings-card">{([
              { key: 'area', label: 'Area' }, { key: 'display', label: 'Display' }, { key: 'full', label: 'Full page' },
            ] as const).map(shortcut => <Row key={shortcut.key} label={shortcut.label}><div className="settings-shortcut-controls"><kbd>{shortcuts[shortcut.key]}</kbd><button type="button" className="settings-shortcut-edit" aria-label={`Edit ${shortcut.label.toLowerCase()} shortcut`} title="Open browser keyboard shortcut settings" disabled={!extension} onClick={() => void openBrowserShortcuts()}>Edit</button></div></Row>)}</div>
            {!extension && <p className="settings-row-description mt-3">Install ImageShot to edit browser shortcuts.</p>}
          </>}
          {tab === 'about' && <>
            <h2>ImageShot</h2>
            <div className="settings-card"><Row label="Version"><span className="rounded bg-field px-2 py-1 text-[12px]">{version}</span></Row></div>
            <p className="settings-row-description mt-3">Screenshots and edits stay on your device.</p>
          </>}
          <div className="settings-status">{error ? <p role="alert" className="text-danger">{error}</p> : <p role="status">{loading ? 'Loading…' : saving ? 'Saving…' : status}</p>}</div>
        </div>
      </div>
    </section>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} aria-label="Settings" className="settings-dialog" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}><Settings onClose={onClose} /></dialog>;
}

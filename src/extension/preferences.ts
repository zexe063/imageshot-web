/** Shared preferences for extension pages, the worker, and the browser preview. */
export type CaptureDestination = 'panel' | 'studio';
export type Theme = 'system' | 'light' | 'dark';
export type FileFormat = 'png' | 'jpg';

export const PREFERENCE_KEYS = {
  captureDestination: 'imageshot:quickCopy',
  theme: 'imageshot:theme',
  autoCopy: 'imageshot:autoCopy',
  freezeScreen: 'imageshot:freezeScreen',
  fileFormat: 'imageshot:fileFormat',
} as const;

const localListeners = new Set<(keys: string[]) => void>();

function extensionStorage() {
  return typeof chrome !== 'undefined' ? chrome.storage?.local : undefined;
}

function readLocal(key: string): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw === null || raw === undefined ? undefined : JSON.parse(raw);
  } catch { return undefined; }
}

async function read(key: string): Promise<unknown> {
  const storage = extensionStorage();
  if (storage) {
    try { return (await storage.get(key))[key]; } catch { return readLocal(key); }
  }
  return readLocal(key);
}

async function write(key: string, value: unknown): Promise<void> {
  const storage = extensionStorage();
  if (storage) {
    // A failed extension write must be reported, not presented as a saved setting.
    await storage.set({ [key]: value });
    try { globalThis.localStorage?.setItem(key, JSON.stringify(value)); } catch { /* Optional startup cache. */ }
  } else {
    if (!globalThis.localStorage) throw new Error('Settings storage is unavailable.');
    globalThis.localStorage.setItem(key, JSON.stringify(value));
  }
  localListeners.forEach(listener => listener([key]));
}

/** Notify open views both across extension pages and within this document. */
export function subscribePreferences(listener: (keys: string[]) => void): () => void {
  localListeners.add(listener);
  const onChromeChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local') listener(Object.keys(changes));
  };
  const onStorage = (event: StorageEvent) => {
    // Extension pages use Chrome's authoritative event, not changes to its startup cache.
    if (!extensionStorage()) listener(event.key ? [event.key] : Object.values(PREFERENCE_KEYS));
  };
  if (typeof chrome !== 'undefined') chrome.storage?.onChanged?.addListener(onChromeChange);
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    localListeners.delete(listener);
    if (typeof chrome !== 'undefined') chrome.storage?.onChanged?.removeListener(onChromeChange);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

export async function readCaptureDestination(): Promise<CaptureDestination> {
  return await read(PREFERENCE_KEYS.captureDestination) === false ? 'studio' : 'panel';
}
export function writeCaptureDestination(destination: CaptureDestination): Promise<void> {
  return write(PREFERENCE_KEYS.captureDestination, destination === 'panel');
}
export async function readTheme(): Promise<Theme> {
  const value = await read(PREFERENCE_KEYS.theme);
  return value === 'light' || value === 'dark' ? value : 'system';
}
export function readCachedTheme(): Theme {
  const value = readLocal(PREFERENCE_KEYS.theme);
  return value === 'light' || value === 'dark' ? value : 'system';
}
export function cacheTheme(theme: Theme): void {
  try { globalThis.localStorage?.setItem(PREFERENCE_KEYS.theme, JSON.stringify(theme)); } catch { /* Startup cache is optional. */ }
}
export function writeTheme(theme: Theme): Promise<void> {
  return write(PREFERENCE_KEYS.theme, theme);
}
export async function readAutoCopy(): Promise<boolean> {
  return await read(PREFERENCE_KEYS.autoCopy) === true;
}
export function writeAutoCopy(enabled: boolean): Promise<void> {
  return write(PREFERENCE_KEYS.autoCopy, enabled);
}
/** Keep the initial viewport frame still while selecting an area. */
export async function readFreezeScreen(): Promise<boolean> {
  return await read(PREFERENCE_KEYS.freezeScreen) === true;
}
export function writeFreezeScreen(enabled: boolean): Promise<void> {
  return write(PREFERENCE_KEYS.freezeScreen, enabled);
}
export async function readFileFormat(): Promise<FileFormat> {
  return await read(PREFERENCE_KEYS.fileFormat) === 'jpg' ? 'jpg' : 'png';
}
export function writeFileFormat(format: FileFormat): Promise<void> {
  return write(PREFERENCE_KEYS.fileFormat, format);
}

/** Actual browser bindings; Chrome does not let extensions reassign these. */
export async function readShortcuts(): Promise<{ area: string; display: string; full: string }> {
  if (typeof chrome !== 'undefined' && chrome.commands?.getAll) {
    const commands = await chrome.commands.getAll();
    return {
      area: commands.find(command => command.name === 'capture-area')?.shortcut || 'Not assigned',
      display: commands.find(command => command.name === 'capture-display')?.shortcut || 'Not assigned',
      full: commands.find(command => command.name === 'capture-full')?.shortcut || 'Not assigned',
    };
  }
  return { area: 'Alt+Shift+R', display: 'Alt+Shift+A', full: 'Alt+Shift+F' };
}

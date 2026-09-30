/**
 * All ImageShot preferences live in chrome.storage.local.
 * Every getter has a safe fallback so the extension works even on file:// or when storage is blocked.
 */
export type CaptureDestination = 'panel' | 'studio';

const QUICK_COPY_KEY = 'imageshot:quickCopy';
const THEME_KEY = 'imageshot:theme';
const AUTO_COPY_KEY = 'imageshot:autoCopy';
const FILE_FORMAT_KEY = 'imageshot:fileFormat';
const SHOW_PANEL_KEY = 'imageshot:showPanel';
const SHORTCUT_DISPLAY_KEY = 'imageshot:shortcut:display';
const SHORTCUT_FULL_KEY = 'imageshot:shortcut:full';

// --- capture destination ---
export async function readCaptureDestination(): Promise<CaptureDestination> {
  try {
    const stored = await chrome.storage.local.get(QUICK_COPY_KEY);
    return stored[QUICK_COPY_KEY] === false ? 'studio' : 'panel';
  } catch { return 'panel'; }
}
export async function writeCaptureDestination(destination: CaptureDestination): Promise<void> {
  try { await chrome.storage.local.set({ [QUICK_COPY_KEY]: destination === 'panel' }); } catch {}
}

// --- theme ---
export type Theme = 'system' | 'light' | 'dark';
export async function readTheme(): Promise<Theme> {
  try {
    const stored = await chrome.storage.local.get(THEME_KEY);
    const v = stored[THEME_KEY];
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch { return 'system'; }
}
export async function writeTheme(theme: Theme): Promise<void> {
  try { await chrome.storage.local.set({ [THEME_KEY]: theme }); } catch {}
}

// --- auto copy ---
export async function readAutoCopy(): Promise<boolean> {
  try {
    const s = await chrome.storage.local.get(AUTO_COPY_KEY);
    return s[AUTO_COPY_KEY] === true;
  } catch { return false; }
}
export async function writeAutoCopy(enabled: boolean): Promise<void> {
  try { await chrome.storage.local.set({ [AUTO_COPY_KEY]: enabled }); } catch {}
}

// --- show panel ---
export async function readShowPanel(): Promise<boolean> {
  try {
    const s = await chrome.storage.local.get(SHOW_PANEL_KEY);
    return s[SHOW_PANEL_KEY] === false ? false : true;
  } catch { return true; }
}
export async function writeShowPanel(show: boolean): Promise<void> {
  try { await chrome.storage.local.set({ [SHOW_PANEL_KEY]: show }); } catch {}
}

// --- file format ---
export type FileFormat = 'png' | 'jpg';
export async function readFileFormat(): Promise<FileFormat> {
  try {
    const s = await chrome.storage.local.get(FILE_FORMAT_KEY);
    return s[FILE_FORMAT_KEY] === 'jpg' ? 'jpg' : 'png';
  } catch { return 'png'; }
}
export async function writeFileFormat(format: FileFormat): Promise<void> {
  try { await chrome.storage.local.set({ [FILE_FORMAT_KEY]: format }); } catch {}
}

// --- shortcuts (labels the user edits in Settings; real Chrome bindings are in chrome://extensions) ---
export async function readShortcuts(): Promise<{ display: string; full: string }> {
  try {
    const s = await chrome.storage.local.get([SHORTCUT_DISPLAY_KEY, SHORTCUT_FULL_KEY]) as Record<string, string>;
    return { display: s[SHORTCUT_DISPLAY_KEY] ?? 'Alt+Shift+A', full: s[SHORTCUT_FULL_KEY] ?? 'Alt+Shift+F' };
  } catch { return { display: 'Alt+Shift+A', full: 'Alt+Shift+F' }; }
}
export async function writeShortcuts(shortcuts: { display: string; full: string }): Promise<void> {
  try { await chrome.storage.local.set({ [SHORTCUT_DISPLAY_KEY]: shortcuts.display, [SHORTCUT_FULL_KEY]: shortcuts.full }); } catch {}
}

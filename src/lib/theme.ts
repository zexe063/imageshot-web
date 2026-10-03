import { useSyncExternalStore } from 'react';
import { PREFERENCE_KEYS, cacheTheme, readCachedTheme, readTheme, subscribePreferences, writeTheme, type Theme } from '../extension/preferences';

type ResolvedTheme = 'light' | 'dark';
let current = { theme: readCachedTheme(), resolvedTheme: 'light' as ResolvedTheme };
let initialized = false;
let revision = 0;
const listeners = new Set<() => void>();
let systemTheme: MediaQueryList | undefined;

function apply(theme: Theme) {
  const resolvedTheme: ResolvedTheme = theme === 'system' ? (systemTheme?.matches ? 'dark' : 'light') : theme;
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.style.colorScheme = resolvedTheme;
  if (current.theme !== theme || current.resolvedTheme !== resolvedTheme) {
    current = { theme, resolvedTheme };
    listeners.forEach(listener => listener());
  }
}

/** Install once per document; every mounted view then shares the same appearance. */
export function bootstrapTheme(): () => void {
  if (initialized || typeof document === 'undefined') return () => {};
  initialized = true;
  systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  apply(current.theme);
  const onSystemChange = () => apply(current.theme);
  systemTheme.addEventListener('change', onSystemChange);
  const refresh = () => {
    const request = ++revision;
    void readTheme().then(theme => {
      if (request === revision) { apply(theme); cacheTheme(theme); }
    });
  };
  const unsubscribe = subscribePreferences(keys => { if (keys.includes(PREFERENCE_KEYS.theme)) refresh(); });
  refresh();
  return () => {
    unsubscribe();
    systemTheme?.removeEventListener('change', onSystemChange);
    initialized = false;
    ++revision;
  };
}

async function setTheme(theme: Theme): Promise<void> {
  bootstrapTheme();
  const change = ++revision;
  const previous = current.theme;
  apply(theme);
  try { await writeTheme(theme); }
  catch (error) {
    // Do not roll back a newer preference received from another open page.
    if (change === revision) apply(previous);
    throw error;
  }
}

function subscribe(listener: () => void) {
  bootstrapTheme();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, () => current);
  return { ...snapshot, setTheme };
}

/**
 * Where a finished capture goes. `panel` leaves the user on the page with the
 * screenshot and a copy button, `studio` opens the editor as it always did.
 */
export type CaptureDestination = 'panel' | 'studio';

const QUICK_COPY_KEY = 'imageshot:quickCopy';

/** Defaults to the in-page panel, which is the point of the quick copy. */
export async function readCaptureDestination(): Promise<CaptureDestination> {
  try {
    const stored = await chrome.storage.local.get(QUICK_COPY_KEY);
    return stored[QUICK_COPY_KEY] === false ? 'studio' : 'panel';
  } catch {
    return 'panel';
  }
}

export async function writeCaptureDestination(destination: CaptureDestination): Promise<void> {
  try {
    await chrome.storage.local.set({ [QUICK_COPY_KEY]: destination === 'panel' });
  } catch {
    // A capture that cannot record the choice still works, it just uses the default.
  }
}

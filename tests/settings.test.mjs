import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';

const url = process.env.IMAGESHOT_SETTINGS_TEST_URL || 'http://127.0.0.1:5175';
let browser;
let server;

before(async () => {
  try { await fetch(url); }
  catch {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5175', '--strictPort'], { stdio: 'ignore', windowsHide: true });
    const deadline = Date.now() + 20000;
    for (;;) {
      try { await fetch(url); break; }
      catch {
        if (Date.now() > deadline) throw new Error('The settings test server did not start.');
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
  }
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ headless: true, channel: 'chrome' }); }
});

after(async () => { await browser?.close(); server?.kill(); });

test('settings render the bundled Geist font in the popup, options page, and editor', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await session.send('DOM.enable');
  await session.send('CSS.enable');
  try {
    for (const surface of ['popup', 'options', 'editor']) {
      await page.goto(`${url}/${surface === 'options' ? 'setting' : surface}.html`);
      assert.match(await page.locator('html').evaluate(element => getComputedStyle(element).fontFamily), /^["']?Geist Variable\b/, `${surface} uses Geist at the document root`);
      if (surface === 'popup') await page.getByRole('button', { name: 'Settings', exact: true }).click();
      if (surface === 'editor') {
        await page.getByTestId('editor-artboard').waitFor();
        const canvasFace = await page.evaluate(() => [...document.fonts].find(face => face.family === 'Inter Variable')?.status);
        assert.equal(canvasFace, 'loaded', 'the editor loads Inter before the first canvas measurement');
        await page.getByRole('button', { name: 'File menu', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
      }
      await expect(page.locator('.settings-shell h1')).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const { root } = await session.send('DOM.getDocument');
      const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.settings-shell h1' });
      const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId });
      assert.ok(fonts.some(font => font.isCustomFont && font.familyName.startsWith('Geist') && font.glyphCount > 0), `${surface} renders the bundled Geist font, not a system fallback`);
      await page.getByRole('button', { name: 'Capture', exact: true }).click();
      for (const selector of ['.settings-row-label', '.settings-tabs button', '.settings-row select']) {
        const family = await page.locator(selector).first().evaluate(element => getComputedStyle(element).fontFamily);
        assert.match(family, /^["']?Geist Variable\b/, `${surface} ${selector} inherits the UI font`);
        const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector });
        const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId });
        assert.ok(fonts.some(font => font.isCustomFont && font.familyName.startsWith('Geist') && font.glyphCount > 0), `${surface} ${selector} renders bundled Geist`);
      }
    }
  } finally { await context.close(); }
});

test('popup settings stay in place, persist capture choices, and never reset the destination', async () => {
  const context = await browser.newContext({ viewport: { width: 420, height: 650 } });
  const page = await context.newPage();
  try {
    await page.goto(`${url}/popup.html`);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    assert.equal(context.pages().length, 1);
    assert.equal(new URL(page.url()).pathname, '/popup.html');
    await page.getByRole('radio', { name: 'Dark', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('status')).toHaveText('Theme saved.');
    await page.getByRole('button', { name: 'Back to capture' }).click();
    assert.equal(await page.getByTestId('capture-popup').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(34, 34, 39)');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Capture', exact: true }).click();
    await page.getByLabel('After capture', { exact: true }).selectOption('studio');
    await expect(page.getByRole('status')).toHaveText('Capture destination saved.');
    await page.getByLabel('Default file format').selectOption('jpg');
    await expect(page.getByRole('status')).toHaveText('Default format saved.');
    await page.getByRole('switch', { name: 'Automatically copy capture' }).click();
    await expect(page.getByRole('switch', { name: 'Automatically copy capture' })).toBeChecked();
    await expect(page.getByRole('switch', { name: 'Show preview panel' })).toHaveCount(0);
    await expect(page.getByRole('switch', { name: 'Freeze screen capture' })).not.toBeChecked();
    await page.getByRole('switch', { name: 'Freeze screen capture' }).click();
    await expect(page.getByRole('switch', { name: 'Freeze screen capture' })).toBeChecked();
    await expect(page.getByLabel('After capture', { exact: true })).toHaveValue('studio');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Capture', exact: true }).click();
    await expect(page.getByLabel('After capture', { exact: true })).toHaveValue('studio');
    await expect(page.getByLabel('Default file format')).toHaveValue('jpg');
    await expect(page.getByRole('switch', { name: 'Automatically copy capture' })).toBeChecked();
    await expect(page.getByRole('switch', { name: 'Freeze screen capture' })).toBeChecked();
    assert.equal(await page.evaluate(() => localStorage.getItem('imageshot:quickCopy')), 'false');
    assert.ok(await page.locator('.settings-shell').evaluate(element => element.scrollWidth <= element.clientWidth));
    await page.setViewportSize({ width: 310, height: 600 });
    assert.equal(await page.locator('.settings-shell').evaluate(element => element.getBoundingClientRect().width), 390, 'settings request a wider Chrome popup instead of staying clamped to the toolbar width');
  } finally { await context.close(); }
});

test('theme changes synchronize with an open editor and follow system appearance', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const editor = await context.newPage();
  const popup = await context.newPage();
  try {
    await editor.goto(url);
    await editor.getByTestId('editor-artboard').locator('canvas').waitFor();
    await editor.getByRole('button', { name: 'File menu', exact: true }).click();
    await editor.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const dialog = editor.getByRole('dialog', { name: 'Settings', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('radio', { name: 'Dark', exact: true }).click();
    await expect(editor.locator('html')).toHaveAttribute('data-theme', 'dark');
    await popup.goto(`${url}/popup.html`);
    await expect(popup.locator('html')).toHaveAttribute('data-theme', 'dark');
    await popup.getByRole('button', { name: 'Settings', exact: true }).click();
    await popup.getByRole('radio', { name: 'Light', exact: true }).click();
    await expect(editor.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(dialog.getByRole('radio', { name: 'Light', exact: true })).toBeChecked();
    const beforePaste = await editor.getByTestId('editor-artboard').locator('canvas').evaluate(canvas => canvas.toDataURL());
    await dialog.evaluate(element => {
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), character => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'unwanted.png', { type: 'image/png' }));
      element.querySelector('button').dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    });
    await editor.waitForTimeout(300);
    assert.equal(await editor.getByTestId('editor-artboard').locator('canvas').evaluate(canvas => canvas.toDataURL()), beforePaste, 'pasting in settings must not replace the image underneath');
    await popup.getByRole('radio', { name: 'System', exact: true }).click();
    await expect(popup.getByRole('status')).toHaveText('Theme saved.');
    await editor.emulateMedia({ colorScheme: 'dark' });
    await popup.emulateMedia({ colorScheme: 'dark' });
    await expect(editor.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(popup.locator('html')).toHaveAttribute('data-theme', 'dark');
    await editor.emulateMedia({ colorScheme: 'light' });
    await expect(editor.locator('html')).toHaveAttribute('data-theme', 'light');
    await dialog.getByRole('radio', { name: 'System', exact: true }).focus();
    await editor.keyboard.press('ArrowRight');
    await expect(dialog.getByRole('radio', { name: 'Light', exact: true })).toBeChecked();
    await expect(dialog.getByRole('radio', { name: 'Light', exact: true })).toBeFocused();
    await editor.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(editor.getByTestId('editor-artboard').locator('canvas')).toBeVisible();
    assert.equal(new URL(editor.url()).pathname, '/');
    assert.equal(context.pages().length, 2);
  } finally { await context.close(); }
});

test('extension settings report failed writes and show actual browser shortcut bindings', async () => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const values = { 'imageshot:theme': 'light', 'imageshot:quickCopy': false };
    const listeners = new Set();
    window.__preferenceWrites = [];
    window.__openedSettings = [];
    window.__shortcutBindings = [{ name: 'capture-area', shortcut: 'Ctrl+Shift+R' }, { name: 'capture-display', shortcut: 'Ctrl+Shift+Y' }, { name: 'capture-full', shortcut: '' }];
    window.__rejectFreeze = false;
    window.__setExternalTheme = value => {
      values['imageshot:theme'] = value;
      listeners.forEach(listener => listener({ 'imageshot:theme': { newValue: value } }, 'local'));
    };
    window.chrome = {
      runtime: { id: 'imageshot-test', getManifest: () => ({ version: '1.2.3' }) },
      storage: {
        local: { get: async key => ({ [key]: values[key] }), set: async update => {
          window.__preferenceWrites.push(update);
          if ('imageshot:theme' in update) throw new Error('Storage is full.');
          if ('imageshot:freezeScreen' in update && window.__rejectFreeze) throw new Error('Storage is unavailable.');
          Object.assign(values, update);
          listeners.forEach(listener => listener(Object.fromEntries(Object.entries(update).map(([key, value]) => [key, { newValue: value }])), 'local'));
        } },
        onChanged: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) },
      },
      commands: { getAll: async () => window.__shortcutBindings },
      tabs: { create: async properties => { window.__openedSettings.push(properties.url); } },
    };
  });
  const page = await context.newPage();
  try {
    await page.goto(`${url}/popup.html`);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('radio', { name: 'Dark', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Storage is full.');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.evaluate(() => window.__setExternalTheme('dark'));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    assert.equal(await page.evaluate(() => localStorage.getItem('imageshot:theme')), '"dark"', 'an external Chrome preference refreshes the startup cache');
    await page.getByRole('button', { name: 'Capture', exact: true }).click();
    await expect(page.getByLabel('After capture', { exact: true })).toHaveValue('studio');
    assert.equal((await page.evaluate(() => window.__preferenceWrites)).length, 1, 'opening popup must not overwrite saved preferences');
    await page.evaluate(() => { window.__rejectFreeze = true; });
    await page.getByRole('switch', { name: 'Freeze screen capture' }).click();
    await expect(page.getByRole('alert')).toContainText('Storage is unavailable.');
    await expect(page.getByRole('switch', { name: 'Freeze screen capture' })).not.toBeChecked();
    await page.getByRole('button', { name: 'Shortcuts', exact: true }).click();
    await expect(page.locator('kbd')).toHaveCount(3);
    await expect(page.getByText('Area', { exact: true })).toBeVisible();
    await expect(page.getByText('Display', { exact: true })).toBeVisible();
    await expect(page.getByText('Full page', { exact: true })).toBeVisible();
    await expect(page.getByText('Numbered step', { exact: true })).toHaveCount(0);
    await expect(page.locator('kbd').filter({ hasText: 'Ctrl+Shift+R' })).toBeVisible();
    await expect(page.locator('kbd').filter({ hasText: 'Ctrl+Shift+Y' })).toBeVisible();
    await expect(page.locator('kbd').filter({ hasText: 'Not assigned' })).toBeVisible();
    for (const name of ['Edit area shortcut', 'Edit display shortcut', 'Edit full page shortcut']) {
      await page.getByRole('button', { name, exact: true }).click();
    }
    assert.deepEqual(await page.evaluate(() => window.__openedSettings), Array(3).fill('chrome://extensions/shortcuts'));
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.evaluate(() => {
      window.__shortcutBindings = [{ name: 'capture-area', shortcut: 'Alt+R' }, { name: 'capture-display', shortcut: '' }, { name: 'capture-full', shortcut: 'Alt+F' }];
      window.dispatchEvent(new Event('focus'));
    });
    await expect(page.locator('kbd')).toHaveText(['Alt+R', 'Not assigned', 'Alt+F']);
  } finally { await context.close(); }
});

test('Studio auto-copy preserves raw PNG dimensions and runs once per capture load', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    window.__clipboardWrites = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: async items => {
      for (const item of items) {
        const blob = await item.getType('image/png');
        const image = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = image.width; canvas.height = image.height;
        const pixels = canvas.getContext('2d');
        pixels.drawImage(image, 0, 0);
        window.__clipboardWrites.push({ type: blob.type, width: image.width, height: image.height, pixel: [...pixels.getImageData(0, 0, 1, 1).data] });
        image.close();
      }
    } } });
  });
  const page = await context.newPage();
  try {
    await page.goto(`${url}/popup.html`);
    await page.evaluate(async () => {
      const { saveCapture } = await import('/src/lib/capture-store.ts');
      const canvas = document.createElement('canvas');
      canvas.width = 80; canvas.height = 42;
      const pixels = canvas.getContext('2d');
      pixels.fillStyle = '#117744'; pixels.fillRect(0, 0, 80, 42);
      pixels.fillStyle = '#ff0000'; pixels.fillRect(0, 0, 1, 1);
      await saveCapture({ id: 'auto-copy-test', name: 'Raw capture', mode: 'visible', createdAt: Date.now(), width: 80, height: 42, dataUrl: canvas.toDataURL('image/png') });
      localStorage.setItem('imageshot:autoCopy', 'true');
      localStorage.setItem('imageshot:fileFormat', '"jpg"');
    });
    await page.goto(`${url}/editor.html?capture=auto-copy-test`);
    await page.getByTestId('editor-artboard').locator('canvas').waitFor();
    await expect.poll(() => page.evaluate(() => window.__clipboardWrites.length)).toBe(1);
    assert.deepEqual(await page.evaluate(() => window.__clipboardWrites), [{ type: 'image/png', width: 80, height: 42, pixel: [255, 0, 0, 255] }]);
    await page.getByRole('button', { name: 'File menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await page.getByRole('radio', { name: 'Dark', exact: true }).click();
    await page.getByRole('button', { name: 'Close settings' }).click();
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.__clipboardWrites.length), 1, 'changing editor state must not copy again');
    await page.evaluate(() => localStorage.setItem('imageshot:autoCopy', 'false'));
    await page.reload();
    await page.getByTestId('editor-artboard').locator('canvas').waitFor();
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.__clipboardWrites.length), 0, 'disabled auto-copy leaves the clipboard alone');
  } finally { await context.close(); }
});

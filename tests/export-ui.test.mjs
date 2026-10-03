import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const url = process.env.IMAGESHOT_TEST_URL || 'http://127.0.0.1:5173';
let browser;
let server;

before(async () => {
  try { await fetch(url); }
  catch {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', new URL(url).port, '--strictPort'], { stdio: 'ignore', windowsHide: true });
    const deadline = Date.now() + 20000;
    while (true) {
      try { await fetch(url); break; }
      catch {
        if (Date.now() > deadline) throw new Error('Export UI test server did not start.');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ headless: true, channel: 'chrome' }); }
});

after(async () => { await browser?.close(); server?.kill(); });

const copyButton = page => page.getByRole('button', { name: 'Copy image to clipboard', exact: true });
const exportButton = page => page.getByRole('button', { name: 'Export image', exact: true });

async function frames(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function editor(viewport) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  await page.goto(url);
  await page.getByTestId('editor-artboard').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await frames(page);
  return page;
}

async function layout(page, menu = false) {
  const elements = {
    copy: copyButton(page), export: exportButton(page),
    zoom: page.getByTitle('Reset zoom to fit', { exact: true }),
    artboard: page.getByTestId('editor-artboard'), viewport: page.getByTestId('editor-viewport'),
  };
  if (menu) {
    elements.dialog = page.getByRole('dialog', { name: 'Export image', exact: true });
    elements.download = page.getByRole('button', { name: 'Download image', exact: true });
    elements.menuCopy = page.getByRole('button', { name: 'Copy image as PNG', exact: true });
  }
  return Object.fromEntries(await Promise.all(Object.entries(elements).map(async ([name, locator]) => [name, await locator.boundingBox()])));
}

function sameLayout(actual, expected, state) {
  for (const [name, box] of Object.entries(expected)) {
    assert.ok(box && actual[name], `${name} stays visible ${state}`);
    for (const axis of ['x', 'y', 'width', 'height']) {
      assert.ok(Math.abs(actual[name][axis] - box[axis]) < 0.1, `${name}.${axis} stays stable ${state}: ${box[axis]} → ${actual[name][axis]}`);
    }
  }
}

async function delayedClipboard(page) {
  await page.evaluate(() => {
    window.__clipboardAttempts = 0;
    window.__copiedPngSizes = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      write: async items => {
        window.__clipboardAttempts += 1;
        const blob = await items[0].getType('image/png');
        window.__copiedPngSizes.push(blob.size);
        await new Promise((resolve, reject) => {
          window.__finishCopy = fail => {
            delete window.__finishCopy;
            if (fail) reject(new DOMException('Clipboard permission denied', 'NotAllowedError'));
            else resolve();
          };
        });
      },
    } });
  });
}

for (const [label, viewport] of [
  ['desktop', { width: 1440, height: 1000 }],
  ['compact', { width: 880, height: 900 }],
]) {
  test(`copy loading keeps the ${label} layout stable and recovers after clipboard rejection`, async () => {
    const page = await editor(viewport);
    try {
      await delayedClipboard(page);
      const before = await layout(page);
      await copyButton(page).evaluate(button => { button.click(); button.click(); });
      await page.waitForFunction(() => !!window.__finishCopy);
      assert.equal(await copyButton(page).getAttribute('aria-busy'), 'true');
      assert.ok(await copyButton(page).isDisabled());
      assert.ok(await exportButton(page).isDisabled());
      assert.equal(await exportButton(page).getAttribute('aria-busy'), null, 'the loader identifies the active action');
      assert.equal(await page.evaluate(() => window.__clipboardAttempts), 1, 'two immediate clicks start one clipboard write');
      await frames(page);
      sameLayout(await layout(page), before, 'during copy');

      await page.evaluate(() => window.__finishCopy(true));
      await page.waitForFunction(() => !document.querySelector('[aria-label="Copy image to clipboard"]').disabled);
      assert.equal(await copyButton(page).getAttribute('aria-busy'), null);
      assert.ok(await exportButton(page).isEnabled());
      await page.getByRole('status').filter({ hasText: /clipboard/i }).waitFor();
      sameLayout(await layout(page), before, 'after a copy error');

      await exportButton(page).click();
      await page.getByRole('img', { name: 'Export preview', exact: true }).waitFor();
      const menuCopy = page.getByRole('button', { name: 'Copy image as PNG', exact: true });
      const menuBefore = await layout(page, true);
      await menuCopy.click();
      await page.waitForFunction(() => !!window.__finishCopy);
      assert.equal(await menuCopy.getAttribute('aria-busy'), 'true');
      assert.equal(await copyButton(page).getAttribute('aria-busy'), 'true');
      assert.ok(await page.getByRole('button', { name: 'Download image', exact: true }).isDisabled());
      sameLayout(await layout(page, true), menuBefore, 'during copy retry');
      await page.evaluate(() => window.__finishCopy(false));
      await page.waitForFunction(() => !document.querySelector('[aria-label="Copy image as PNG"]').disabled);
      assert.equal(await menuCopy.getAttribute('aria-busy'), null);
      assert.equal(await copyButton(page).getAttribute('aria-busy'), null);
      assert.equal(await page.evaluate(() => window.__clipboardAttempts), 2);
      assert.ok(await page.evaluate(() => window.__copiedPngSizes.every(size => size > 1000)), 'both attempts encode real PNG data');
      await page.getByRole('status').filter({ hasText: 'Image copied to clipboard.' }).waitFor();
      sameLayout(await layout(page, true), menuBefore, 'after successful copy');
    } finally { await page.close(); }
  });

  test(`PNG export paints its loader and preserves the ${label} layout while encoding`, async () => {
    const page = await editor(viewport);
    try {
      await exportButton(page).click();
      await page.getByRole('img', { name: 'Export preview', exact: true }).waitFor();
      const downloadButton = page.getByRole('button', { name: 'Download image', exact: true });
      const before = await layout(page, true);
      const headerBefore = await layout(page);
      await page.evaluate(() => {
        const original = HTMLCanvasElement.prototype.toBlob;
        window.__encodeCalls = 0;
        window.__loaderFrames = 0;
        const inspectFrame = () => {
          if (document.querySelector('[aria-label="Download image"][aria-busy="true"]')) window.__loaderFrames += 1;
          window.__exportFrame = requestAnimationFrame(inspectFrame);
        };
        window.__exportFrame = requestAnimationFrame(inspectFrame);
        HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
          window.__encodeCalls += 1;
          window.__loaderFramesAtEncoding = window.__loaderFrames;
          window.__busyAtEncoding = document.querySelector('[aria-label="Download image"]')?.getAttribute('aria-busy');
          original.call(this, blob => { window.__finishEncode = () => { delete window.__finishEncode; callback(blob); }; }, ...args);
        };
      });
      await downloadButton.evaluate(button => { button.click(); button.click(); });
      await page.waitForFunction(() => !!window.__finishEncode);
      assert.equal(await downloadButton.getAttribute('aria-busy'), 'true');
      assert.equal(await exportButton(page).getAttribute('aria-busy'), 'true');
      assert.ok(await downloadButton.isDisabled());
      assert.ok(await copyButton(page).isDisabled());
      assert.ok(await page.getByRole('button', { name: 'Copy image as PNG', exact: true }).isDisabled());
      const encoding = await page.evaluate(() => ({ calls: window.__encodeCalls, frames: window.__loaderFramesAtEncoding, busy: window.__busyAtEncoding }));
      assert.equal(encoding.calls, 1, 'two immediate clicks encode one download');
      assert.equal(encoding.busy, 'true');
      assert.ok(encoding.frames >= 1, 'a rendering frame sees the loader before PNG encoding starts');
      sameLayout(await layout(page, true), before, 'while PNG encoding is pending');
      const downloadEvent = page.waitForEvent('download');
      await page.evaluate(() => window.__finishEncode());
      const download = await downloadEvent;
      const bytes = await readFile(await download.path());
      assert.match(download.suggestedFilename(), /\.png$/);
      assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG');
      assert.equal(bytes.readUInt32BE(16), 1200);
      assert.equal(bytes.readUInt32BE(20), 760);
      await page.getByRole('dialog', { name: 'Export image', exact: true }).waitFor({ state: 'detached' });
      assert.equal(await exportButton(page).getAttribute('aria-busy'), null);
      assert.ok(await exportButton(page).isEnabled());
      assert.ok(await copyButton(page).isEnabled());
      sameLayout(await layout(page), headerBefore, 'after PNG download');
      await page.evaluate(() => cancelAnimationFrame(window.__exportFrame));
    } finally { await page.close(); }
  });
}

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const url = process.env.IMAGESHOT_TEXT_INTERACTION_TEST_URL || 'http://127.0.0.1:5186';
let browser;
let server;

before(async () => {
  try { await fetch(url); }
  catch {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5186', '--strictPort'], { stdio: 'ignore', windowsHide: true });
    const deadline = Date.now() + 20000;
    while (true) {
      try { await fetch(url); break; }
      catch {
        if (Date.now() > deadline) throw new Error('Text interaction test server did not start.');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ headless: true, channel: 'chrome' }); }
});

after(async () => { await browser?.close(); server?.kill(); });

async function editor() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
  await page.goto(url);
  await page.locator('[data-testid="editor-artboard"] > canvas').waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
}

async function clickImage(page, x, y) {
  const position = await page.locator('[data-testid="editor-artboard"]').evaluate((stage, [x, y]) => {
    const box = stage.getBoundingClientRect();
    const svg = stage.querySelector('svg');
    const view = svg.getAttribute('viewBox').split(' ').map(Number);
    const [offsetX, offsetY] = svg.querySelector('g').getAttribute('transform').match(/[\d.-]+/g).map(Number);
    return { x: box.x + (x + offsetX) * box.width / view[2], y: box.y + (y + offsetY) * box.height / view[3] };
  }, [x, y]);
  await page.mouse.click(position.x, position.y);
}

async function startText(page, x = 240, y = 170) {
  await page.getByRole('button', { name: 'Text (T)', exact: true }).click();
  await clickImage(page, x, y);
  const input = page.getByLabel('Annotation text', { exact: true });
  await input.waitFor();
  return input;
}

const layers = page => page.locator('[data-testid="layer-select"]');
const inlineFrame = page => page.getByTestId('inline-text-editor').evaluate(element => ({
  width: parseFloat(element.style.width), height: parseFloat(element.style.height),
}));

test('text starts with an empty caret, grows with typing, and keeps its exact frame on Escape', async () => {
  const page = await editor();
  try {
    const initialLayers = await layers(page).count();
    const input = await startText(page);
    assert.equal(await input.inputValue(), '');
    assert.equal(await input.getAttribute('placeholder'), null);
    assert.ok(await input.evaluate(element => element === document.activeElement), 'clicking the canvas is enough to start typing');
    const empty = await page.getByTestId('inline-text-editor').evaluate(element => {
      const canvas = element.querySelector('canvas');
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      return { ink: pixels.some((channel, index) => index % 4 === 3 && channel > 0), outline: getComputedStyle(element).outlineStyle };
    });
    assert.equal(empty.ink, false, 'no placeholder or empty preset background is painted');
    assert.equal(empty.outline, 'none', 'the empty insertion point has no fake text box');
    assert.equal(await layers(page).count(), initialLayers, 'an insertion point is not a saved layer');

    const emptyFrame = await inlineFrame(page);
    await page.keyboard.type('Clear');
    const shortFrame = await inlineFrame(page);
    await page.keyboard.type(' annotation');
    const wideFrame = await inlineFrame(page);
    assert.ok(shortFrame.width > emptyFrame.width);
    assert.ok(wideFrame.width > shortFrame.width * 2);
    await input.press('Enter');
    await page.keyboard.type('Second line');
    const multilineFrame = await inlineFrame(page);
    assert.ok(multilineFrame.height >= wideFrame.height * 1.99, 'Enter grows the frame by a line');
    await input.press('Escape');
    await input.waitFor({ state: 'detached' });
    assert.equal(await layers(page).count(), initialLayers + 1);
    assert.equal(await layers(page).filter({ hasText: 'Clear annotation' }).count(), 1, 'Escape keeps the text just entered');
    const selectedFrame = await page.getByTestId('selection-bounds').evaluate(element => ({
      width: +element.getAttribute('width'), height: +element.getAttribute('height'),
    }));
    assert.ok(Math.abs(selectedFrame.width - multilineFrame.width) < 0.01);
    assert.ok(Math.abs(selectedFrame.height - multilineFrame.height) < 0.01, 'committing never jumps or resizes the text');
    assert.equal(await page.getByRole('button', { name: 'Select (V)', exact: true }).getAttribute('aria-pressed'), 'true');
  } finally { await page.close(); }
});

test('clicking away discards empty drafts and commits real text once; text-tool clicks edit the same layer', async () => {
  const page = await editor();
  try {
    const initialLayers = await layers(page).count();
    const input = await startText(page);
    await clickImage(page, 650, 450);
    await input.waitFor({ state: 'detached' });
    assert.equal(await layers(page).count(), initialLayers);
    assert.equal(await page.getByRole('button', { name: 'Select (V)', exact: true }).getAttribute('aria-pressed'), 'true');

    await startText(page);
    await input.fill('   \n  ');
    await input.press('Control+Enter');
    assert.equal(await layers(page).count(), initialLayers, 'whitespace does not leave an invisible layer');

    await startText(page);
    await input.fill('Click away to finish');
    await clickImage(page, 650, 450);
    await input.waitFor({ state: 'detached' });
    assert.equal(await layers(page).count(), initialLayers + 1);
    assert.equal(await layers(page).filter({ hasText: 'Click away to finish' }).count(), 1);
    await startText(page, 250, 185);
    assert.equal(await input.inputValue(), 'Click away to finish', 'the text tool opens existing text where clicked');
    await input.fill('Revised text');
    await input.press('Escape');
    assert.equal(await layers(page).count(), initialLayers + 1, 'editing does not add an overlapping layer');
    assert.equal(await layers(page).filter({ hasText: 'Revised text' }).count(), 1);
    await page.keyboard.press('Control+z');
    assert.equal(await layers(page).filter({ hasText: 'Click away to finish' }).count(), 1, 'an edit is one undo step');
  } finally { await page.close(); }
});

test('IME composition finishes before a click-away commit and empty edits remove their layer', async () => {
  const page = await editor();
  try {
    const initialLayers = await layers(page).count();
    const input = await startText(page);
    await input.dispatchEvent('compositionstart', { data: '' });
    await input.fill('日本');
    await input.press('Escape');
    assert.ok(await input.isVisible(), 'Escape during composition is left to the input method');
    await clickImage(page, 650, 450);
    assert.ok(await input.isVisible(), 'blur waits for the final composed characters');
    await input.fill('日本語');
    await input.dispatchEvent('compositionend', { data: '日本語' });
    await input.waitFor({ state: 'detached' });
    assert.equal(await layers(page).filter({ hasText: '日本語' }).count(), 1);
    assert.equal(await layers(page).count(), initialLayers + 1);
    await startText(page, 250, 185);
    await input.fill('');
    await input.press('Escape');
    assert.equal(await layers(page).count(), initialLayers, 'finishing an empty existing text layer removes it');
  } finally { await page.close(); }
});

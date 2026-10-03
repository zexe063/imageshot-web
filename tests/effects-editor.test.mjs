import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';

const baseUrl = process.env.IMAGESHOT_TEST_URL || 'http://127.0.0.1:5173';
const url = new URL('?effects-editor-test', baseUrl).href;
let browser, server;
before(async () => {
  try { await fetch(baseUrl); } catch {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], { stdio: 'ignore', windowsHide: true });
    const deadline = Date.now() + 20000;
    while (true) {
      try { await fetch(baseUrl); break; } catch {
        if (Date.now() > deadline) throw new Error('The ImageShot effects test server did not start.');
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  }
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ headless: true, channel: 'chrome' }); }
});
after(async () => { await browser?.close(); server?.kill(); });

async function editor(width = 1440) {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(url);
  await page.locator('[data-testid="editor-artboard"] canvas').waitFor();
  return page;
}

async function drag(page, from, to) {
  const positions = await page.locator('[data-testid="editor-artboard"]').evaluate((stage, points) => {
    const bounds = stage.getBoundingClientRect(), svg = stage.querySelector('svg');
    const viewBox = svg.getAttribute('viewBox').split(' ').map(Number);
    const [offsetX, offsetY] = svg.querySelector('g').getAttribute('transform').match(/[\d.-]+/g).map(Number);
    return points.map(([x, y]) => ({ x: bounds.x + (x + offsetX) * bounds.width / viewBox[2], y: bounds.y + (y + offsetY) * bounds.height / viewBox[3] }));
  }, [from, to]);
  await page.mouse.move(positions[0].x, positions[0].y);
  await page.mouse.down();
  await page.mouse.move(positions[1].x, positions[1].y, { steps: 10 });
  await page.mouse.up();
}

async function setNumber(page, label, value) {
  const field = page.getByLabel(label, { exact: true });
  await field.fill(String(value)); await field.press('Enter');
}

async function painted(page) {
  await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
  return page.locator('[data-testid="editor-artboard"] canvas').evaluate(canvas => canvas.toDataURL());
}

test('Blur and Spotlight inspector changes survive undo, reload, and PNG export', async () => {
  const page = await editor();
  try {
    const imageData = await page.evaluate(() => {
      const source = document.createElement('canvas'); source.width = 600; source.height = 400;
      const context = source.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 600, 400);
      context.fillStyle = '#000'; context.fillRect(300, 0, 300, 400);
      return source.toDataURL().split(',')[1];
    });
    await page.locator('input[type="file"]').setInputFiles({ name: 'effects.png', mimeType: 'image/png', buffer: Buffer.from(imageData, 'base64') });
    await page.waitForFunction(() => document.querySelector('[data-testid="editor-artboard"] canvas')?.width === 600);
    await page.getByRole('button', { name: 'Blur (B)', exact: true }).click();
    await drag(page, [160, 90], [440, 310]);
    const blurModes = page.getByRole('group', { name: 'Blur mode', exact: true });
    assert.equal(await blurModes.getByRole('button', { name: 'Pixelate', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByLabel('Blur strength', { exact: true }).inputValue(), '16');
    await page.getByLabel('Blur strength', { exact: true }).fill('48');
    await page.getByLabel('Blur strength', { exact: true }).press('Escape');
    assert.equal(await page.getByLabel('Blur strength', { exact: true }).inputValue(), '16', 'Escape discards the uncommitted strength');
    await blurModes.getByRole('button', { name: 'Blur', exact: true }).click();
    await setNumber(page, 'Blur strength', 24);
    const blurred = await painted(page);
    await blurModes.getByRole('button', { name: 'Pixelate', exact: true }).click();
    assert.notEqual(await painted(page), blurred, 'the mode control changes actual rendered pixels');
    await page.keyboard.press('Control+z');
    await page.locator('[data-testid="layer-select"]').filter({ hasText: /^Blur / }).click();
    assert.equal(await blurModes.getByRole('button', { name: 'Blur', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByLabel('Blur strength', { exact: true }).inputValue(), '24');
    assert.equal(await painted(page), blurred, 'undo restores the previous Gaussian result');

    await page.getByRole('button', { name: 'Spotlight (S)', exact: true }).click();
    await drag(page, [200, 60], [450, 340]);
    await page.getByRole('group', { name: 'Spotlight shape', exact: true }).getByRole('button', { name: 'Ellipse', exact: true }).click();
    await setNumber(page, 'Spotlight dim', 80);
    const spotlightLayer = page.locator('[data-testid="layer-select"]').filter({ hasText: /^Spotlight / });
    await spotlightLayer.click();
    await page.keyboard.press('Control+z');
    await spotlightLayer.click();
    assert.equal(await page.getByLabel('Spotlight dim', { exact: true }).inputValue(), '65');
    await page.keyboard.press('Control+Shift+z');
    await spotlightLayer.click();
    assert.equal(await page.getByLabel('Spotlight dim', { exact: true }).inputValue(), '80');
    await expect.poll(() => page.evaluate(async () => {
      const { readDraft } = await import('/src/lib/document-store.ts');
      const document = await readDraft();
      return document?.annotations.some(annotation => annotation.type === 'blur' && annotation.blurMode === 'blur' && annotation.blurAmount === 24)
        && document.annotations.some(annotation => annotation.type === 'spotlight' && annotation.spotlightShape === 'ellipse' && annotation.spotlightDim === 80);
    }), { message: 'the current effects are saved before reloading', timeout: 10000 }).toBe(true);
    const beforeReload = await painted(page);
    await page.reload();
    await page.locator('[data-testid="editor-artboard"] canvas').waitFor();
    await spotlightLayer.click();
    assert.equal(await page.getByLabel('Spotlight dim', { exact: true }).inputValue(), '80');
    assert.equal(await page.getByRole('group', { name: 'Spotlight shape', exact: true }).getByRole('button', { name: 'Ellipse', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await painted(page), beforeReload, 'reload retains all effect pixels');

    await page.locator('[data-testid="header-actions"]').getByRole('button', { name: 'Export image', exact: true }).click();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download image', exact: true }).click();
    const bytes = await readFile(await (await downloaded).path());
    assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [600, 400]);
    const result = await page.evaluate(async base64 => {
      const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
      const output = document.createElement('canvas'); output.width = image.width; output.height = image.height;
      const context = output.getContext('2d'); context.drawImage(image, 0, 0);
      const preview = document.querySelector('[data-testid="editor-artboard"] canvas');
      return { matches: output.toDataURL() === preview.toDataURL(), dim: [...context.getImageData(50, 50, 1, 1).data], ellipseCorner: [...context.getImageData(205, 65, 1, 1).data], blur: [...context.getImageData(290, 200, 1, 1).data] };
    }, bytes.toString('base64'));
    assert.equal(result.matches, true, 'downloaded PNG and live canvas contain identical pixels at 1×');
    assert.deepEqual(result.dim, [51, 51, 51, 255]);
    assert.deepEqual(result.ellipseCorner, [51, 51, 51, 255], 'elliptical focus excludes the rectangle corner');
    assert.ok(result.blur[0] > 130 && result.blur[0] < 210, 'the clear focus retains the Gaussian blur');
  } finally { await page.close(); }
});

test('All effect toolbar controls remain separate from file and export buttons at 760px', async () => {
  const page = await editor(760);
  try {
    const layout = await page.evaluate(() => {
      const toolbar = document.querySelector('[role="toolbar"][aria-label="Annotation tools"]');
      const rect = element => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, right: box.right, bottom: box.bottom }; };
      const effects = [...toolbar.querySelectorAll('button')].map(element => ({ label: element.getAttribute('aria-label'), ...rect(element) }));
      const other = ['File menu', 'ImageShot menu', 'Export image', 'Copy image to clipboard'].map(label => ({ label, ...rect(document.querySelector(`header [aria-label="${label}"]`)) }));
      return { width: document.documentElement.scrollWidth, effects, other };
    });
    assert.equal(layout.width, 760, 'the header does not overflow horizontally');
    for (const effect of layout.effects) for (const other of layout.other) {
      const overlaps = effect.x < other.right && effect.right > other.x && effect.y < other.bottom && effect.bottom > other.y;
      assert.equal(overlaps, false, `${effect.label} overlaps ${other.label}`);
    }
    await page.getByRole('button', { name: 'Blur (B)', exact: true }).click();
    await page.getByRole('button', { name: 'Spotlight (S)', exact: true }).click();
    await page.getByRole('button', { name: 'Crop (C)', exact: true }).click();
  } finally { await page.close(); }
});

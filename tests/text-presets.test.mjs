import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const url = process.env.IMAGESHOT_TEXT_TEST_URL || 'http://127.0.0.1:5184';
let browser;
let server;
before(async () => {
  try { await fetch(url); }
  catch {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5184', '--strictPort'], { stdio: 'ignore', windowsHide: true });
    const deadline = Date.now() + 20000;
    while (true) {
      try { await fetch(url); break; }
      catch {
        if (Date.now() > deadline) throw new Error('Text preset test server did not start.');
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

async function placeText(page, x, y) {
  const position = await page.locator('[data-testid="editor-artboard"]').evaluate((stage, [x, y]) => {
    const box = stage.getBoundingClientRect();
    const svg = stage.querySelector('svg');
    const view = svg.getAttribute('viewBox').split(' ').map(Number);
    const [offsetX, offsetY] = svg.querySelector('g').getAttribute('transform').match(/[\d.-]+/g).map(Number);
    return { x: box.x + (x + offsetX) * box.width / view[2], y: box.y + (y + offsetY) * box.height / view[3] };
  }, [x, y]);
  await page.mouse.click(position.x, position.y);
  return page.getByLabel('Annotation text', { exact: true });
}

test('all seven text treatments paint inside their measured bounds and survive PNG export', async () => {
  const page = await editor();
  try {
    const results = await page.evaluate(async () => {
      const { TEXT_PRESETS, textPresetPatch } = await import('/src/lib/text-presets.ts');
      const { annotationBounds, renderComposition, textMetrics } = await import('/src/lib/render.ts');
      const { DEFAULT_STYLE } = await import('/src/lib/editor-types.ts');
      const { createExportBlob } = await import('/src/lib/export.ts');
      const empty = document.createElement('canvas'); empty.width = 700; empty.height = 260;
      const source = new Image(); source.src = empty.toDataURL(); await source.decode();
      const result = [];
      for (const preset of TEXT_PRESETS) {
        const annotation = { id: preset.id, type: 'text', x: 40, y: 40, width: 0, height: 0, color: '#141414', strokeWidth: 4,
          text: 'jÁ_Wg\nText', fontSize: 44, lineHeight: 1.3, letterSpacing: 0.5, ...textPresetPatch(preset.id) };
        const preview = renderComposition(source, [annotation], DEFAULT_STYLE);
        const png = await createImageBitmap(await createExportBlob(preview, 'png'));
        const output = document.createElement('canvas'); output.width = png.width; output.height = png.height;
        output.getContext('2d').drawImage(png, 0, 0); png.close();
        const data = output.getContext('2d').getImageData(0, 0, output.width, output.height).data;
        const original = preview.getContext('2d').getImageData(0, 0, output.width, output.height).data;
        let left = Infinity, top = Infinity, right = 0, bottom = 0, ink = 0, white = 0, gray = 0, mismatch = 0;
        for (let index = 0; index < data.length; index += 4) {
          if (data[index + 3] > 0) {
            const x = (index / 4) % output.width, y = Math.floor(index / 4 / output.width);
            left = Math.min(left, x); right = Math.max(right, x + 1); top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
          }
          if (data[index + 3] > 250) {
            if (data[index] < 40) ink += 1;
            if (data[index] > 248) white += 1;
            if (data[index] === 229) gray += 1;
          }
          for (let channel = 0; channel < 4; channel++) if (Math.abs(data[index + channel] - original[index + channel]) > 1) mismatch += 1;
        }
        result.push({ id: preset.id, frame: annotationBounds(annotation), painted: { left, top, right, bottom }, ink, white, gray, mismatch,
          family: textMetrics(annotation).family });
      }
      return result;
    });
    assert.equal(results.length, 7);
    for (const result of results) {
      assert.ok(result.ink > 100, `${result.id} keeps readable foreground ink`);
      assert.equal(result.mismatch, 0, `${result.id} exports the displayed pixels`);
      const { frame, painted } = result;
      assert.ok(painted.left >= Math.floor(frame.x) - 1 && painted.top >= Math.floor(frame.y) - 1, `${result.id} fits the top-left frame edge: ${JSON.stringify(result)}`);
      assert.ok(painted.right <= Math.ceil(frame.x + frame.width) + 1 && painted.bottom <= Math.ceil(frame.y + frame.height) + 1, `${result.id} fits the bottom-right frame edge`);
    }
    assert.ok(results.find(result => result.id === 'outlined').white > 100, 'Outlined adds visible light ink around dark letters');
    assert.ok(results.find(result => result.id === 'boxed').gray > 1000, 'Boxed adds its neutral background');
    assert.ok(results.find(result => result.id === 'rounded-boxed').gray > 1000, 'Rounded Boxed retains its pill background');
    assert.ok(results.find(result => result.id === 'monospaced-boxed').white > 1000, 'Monospaced Boxed uses a white background');
    assert.equal(results.find(result => result.id === 'rounded').family, 'Rounded');
    assert.equal(results.find(result => result.id === 'monospaced').family, 'Monospaced');
  } finally { await page.close(); }
});

test('text preset changes work during typing, on selections, and on the next text layer', async () => {
  const page = await editor();
  try {
    await page.getByRole('button', { name: 'Text (T)', exact: true }).click();
    assert.equal(await page.getByRole('group', { name: 'Text styles' }).getByRole('button').count(), 7);
    await page.getByRole('button', { name: 'Rounded Boxed text style', exact: true }).click();
    const input = await placeText(page, 260, 180);
    await input.fill('Styled text\nSecond line');
    await page.getByRole('button', { name: 'Outlined text style', exact: true }).click();
    assert.ok(await input.isVisible(), 'choosing a style leaves the native editor active');
    assert.equal(await input.inputValue(), 'Styled text\nSecond line');
    const inline = await page.locator('[data-testid="inline-text-editor"]').evaluate(element => {
      const canvas = element.querySelector('canvas');
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let white = 0;
      for (let index = 0; index < data.length; index += 4) if (data[index] > 248 && data[index + 3] > 250) white += 1;
      return { white, width: element.style.width };
    });
    assert.ok(inline.white > 40, 'the inline preview shows the outline while typing');
    await input.press('Control+Enter');
    await page.getByRole('button', { name: 'Monospaced Boxed text style', exact: true }).click();
    assert.equal((await page.getByLabel('Font family', { exact: true }).textContent()).trim(), 'Monospaced');
    await page.getByRole('button', { name: 'Text (T)', exact: true }).click();
    const next = await placeText(page, 260, 350);
    await next.fill('Future text');
    await next.press('Control+Enter');
    await page.waitForTimeout(1000);
    const saved = await page.evaluate(async () => {
      const { readDraft } = await import('/src/lib/document-store.ts');
      return (await readDraft()).annotations.filter(annotation => annotation.type === 'text');
    });
    assert.equal(saved.length, 2);
    for (const annotation of saved) {
      assert.equal(annotation.textPreset, 'monospaced-boxed', JSON.stringify(saved));
      assert.equal(annotation.fontFamily, 'Monospaced');
      assert.equal(annotation.textBackground, '#ffffff');
      assert.equal(annotation.fontSize, 32, 'presets preserve the chosen font size');
    }
    await page.reload();
    await page.locator('[data-testid="layer-select"]').filter({ hasText: 'Future text' }).click();
    assert.equal(await page.getByRole('button', { name: 'Monospaced Boxed text style', exact: true }).getAttribute('aria-pressed'), 'true');
  } finally { await page.close(); }
});

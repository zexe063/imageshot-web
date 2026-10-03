import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const url = process.env.IMAGESHOT_TEST_URL || 'http://127.0.0.1:5173';
let browser, server;
before(async () => {
  try { await fetch(url); } catch {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], { stdio: 'ignore', windowsHide: true });
    const deadline = Date.now() + 20000;
    while (true) {
      try { await fetch(url); break; } catch {
        if (Date.now() > deadline) throw new Error('The ImageShot test server did not start.');
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  }
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ headless: true, channel: 'chrome' }); }
});
after(async () => { await browser?.close(); server?.kill(); });

async function editor() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(url);
  await page.getByTestId('editor-artboard').waitFor();
  return page;
}
async function point(page, x, y) {
  const stage = page.getByTestId('editor-artboard'), box = await stage.boundingBox();
  const viewBox = (await stage.locator('svg').getAttribute('viewBox')).split(' ').map(Number);
  const [offsetX, offsetY] = (await stage.locator('svg > g').getAttribute('transform')).match(/[\d.-]+/g).map(Number);
  return { x: box.x + (x + offsetX) * box.width / viewBox[2], y: box.y + (y + offsetY) * box.height / viewBox[3] };
}
async function drag(page, from, to) {
  const start = await point(page, ...from), end = await point(page, ...to);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 14 }); await page.mouse.up();
}
async function draft(page) {
  await page.waitForTimeout(900);
  return page.evaluate(async () => (await import('/src/lib/document-store.ts')).readDraft());
}
async function loadTextImage(page) {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 760; canvas.height = 420;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 760, 420);
    ctx.fillStyle = '#202020'; ctx.font = '18px Arial'; ctx.fillText('Readable small text for highlighting', 80, 105);
    ctx.font = '38px Arial'; ctx.fillText('A larger book heading', 80, 225);
    return canvas.toDataURL('image/png');
  });
  await page.locator('input[type="file"]').setInputFiles({ name: 'text-rows.png', mimeType: 'image/png', buffer: Buffer.from(dataUrl.split(',')[1], 'base64') });
  await page.waitForFunction(() => document.querySelector('[data-testid="editor-artboard"] svg')?.getAttribute('viewBox') === '0 0 760 420');
}

test('text-size detection finds both light and dark text and rejects flat shapes', async () => {
  const page = await editor();
  try {
    const result = await page.evaluate(async () => {
      const { detectTextRow } = await import('/src/lib/smart-highlight.ts');
      const canvas = document.createElement('canvas'); canvas.width = 440; canvas.height = 180;
      const ctx = canvas.getContext('2d');
      const detect = (dark, fontSize) => {
        ctx.fillStyle = dark ? '#171717' : '#ffffff'; ctx.fillRect(0, 0, 440, 180);
        ctx.fillStyle = dark ? '#ffffff' : '#202020'; ctx.font = `${fontSize}px Arial`;
        ctx.fillText('Highlight this text size', 25, 95);
        return detectTextRow(ctx.getImageData(0, 0, 440, 180), 95 - fontSize * 0.4);
      };
      const small = detect(false, 16), large = detect(false, 36), dark = detect(true, 24);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 440, 180);
      const blank = detectTextRow(ctx.getImageData(0, 0, 440, 180), 90);
      ctx.fillStyle = '#222222'; ctx.fillRect(30, 75, 360, 25);
      const block = detectTextRow(ctx.getImageData(0, 0, 440, 180), 90);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 440, 180);
      ctx.fillStyle = '#222222'; ctx.fillRect(30, 90, 360, 1);
      const rule = detectTextRow(ctx.getImageData(0, 0, 440, 180), 90);
      return { small, large, dark, blank, block, rule };
    });
    assert.ok(result.small && result.large && result.dark, JSON.stringify(result));
    assert.ok(result.large.height > result.small.height * 1.7, 'larger text receives a visibly taller marker');
    assert.ok(result.small.top < 95 && result.small.bottom <= 100);
    assert.equal(result.blank, null); assert.equal(result.block, null); assert.equal(result.rule, null);
  } finally { await page.close(); }
});

test('book-style highlighting detects text height and keeps manual freehand available', async () => {
  const page = await editor();
  try {
    await loadTextImage(page);
    await page.keyboard.press('h'); await drag(page, [82, 99], [380, 101]);
    let marks = (await draft(page)).annotations.filter(annotation => annotation.type === 'highlight');
    assert.equal(marks.length, 1);
    const small = marks[0];
    assert.equal(small.highlightMode, 'text');
    assert.ok(small.strokeWidth * 4 >= 14 && small.strokeWidth * 4 <= 28);
    assert.ok(small.points.every(p => p.y === 0), 'the marked row is straight');
    await drag(page, [82, 212], [440, 214]);
    marks = (await draft(page)).annotations.filter(annotation => annotation.type === 'highlight');
    assert.ok(marks[1].strokeWidth > small.strokeWidth * 1.5, 'the canvas uses detected text height');
    await page.keyboard.down('Alt'); await drag(page, [100, 300], [500, 345]); await page.keyboard.up('Alt');
    marks = (await draft(page)).annotations.filter(annotation => annotation.type === 'highlight');
    assert.ok(new Set(marks[2].points.map(p => Math.round(p.y))).size > 2, 'Alt preserves the hand-drawn path');
    await drag(page, [100, 370], [500, 371]);
    marks = (await draft(page)).annotations.filter(annotation => annotation.type === 'highlight');
    assert.equal(marks[3].strokeWidth, marks[2].strokeWidth, 'blank areas keep the manual marker size');
  } finally { await page.close(); }
});

test('crop is adjustable and cancellable, preserves layer coordinates and supports undo', async () => {
  const page = await editor();
  try {
    await loadTextImage(page);
    await page.keyboard.press('p'); await drag(page, [130, 130], [200, 175]);
    const before = await draft(page), layer = before.annotations[0];
    await page.keyboard.press('c'); await drag(page, [100, 80], [540, 340]);
    assert.equal(await page.getByTestId('editor-artboard').locator('svg').getAttribute('viewBox'), '0 0 760 420', 'dragging only previews the crop');
    assert.equal(await page.getByTestId('crop-selection').count(), 1);
    await drag(page, [540, 340], [580, 360]);
    await drag(page, [330, 280], [350, 290]);
    const selection = await page.getByTestId('crop-selection').evaluate(element => Object.fromEntries(['x', 'y', 'width', 'height'].map(name => [name, Number(element.getAttribute(name))])));
    assert.ok(Math.abs(selection.x - 120) < 1 && Math.abs(selection.y - 90) < 1, JSON.stringify(selection));
    await page.getByRole('button', { name: 'Cancel crop', exact: true }).click();
    assert.equal(await page.getByTestId('crop-selection').count(), 0);
    assert.equal((await draft(page)).imageSrc, before.imageSrc);
    await page.keyboard.press('c'); await drag(page, [100, 80], [540, 340]);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-testid="editor-artboard"] svg')?.getAttribute('viewBox') !== '0 0 760 420');
    const cropped = await draft(page), cropLayer = cropped.annotations[0];
    assert.ok(cropped.imageSrc !== before.imageSrc);
    assert.ok(Math.abs(cropLayer.x - (layer.x - 100)) <= 1);
    assert.ok(Math.abs(cropLayer.y - (layer.y - 80)) <= 1);
    assert.deepEqual(cropLayer.points, layer.points, 'local ink points remain unchanged');
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => document.querySelector('[data-testid="editor-artboard"] svg')?.getAttribute('viewBox') === '0 0 760 420');
    const restored = await draft(page);
    assert.equal(restored.imageSrc, before.imageSrc); assert.deepEqual(restored.annotations, before.annotations);
    await page.keyboard.press('c'); await drag(page, [90, 80], [500, 300]); await page.keyboard.press('Escape');
    assert.equal(await page.getByTestId('crop-selection').count(), 0);
  } finally { await page.close(); }
});

test('crop geometry clamps at image edges and retains partially visible strokes', async () => {
  const page = await editor();
  try {
    const result = await page.evaluate(async () => {
      const { cropPixelBounds, cropAnnotations, moveCropBox, resizeCropBox } = await import('/src/lib/crop.ts');
      const box = cropPixelBounds({ x: -14.7, y: 80.4, width: 120.2, height: 800 }, 760, 420);
      const ink = { id: 'ink', type: 'pen', x: 75, y: 75, width: 70, height: 40, color: '#000', strokeWidth: 4, points: [{ x: 0, y: 0 }, { x: 70, y: 40 }] };
      const moved = moveCropBox({ x: 20, y: 20, width: 200, height: 100 }, -100, 1000, 760, 420);
      const resized = resizeCropBox({ x: 100, y: 100, width: 200, height: 100 }, 'nw', { x: -40, y: -20 }, 760, 420);
      const layers = cropAnnotations([ink, { ...ink, id: 'outside', x: 600, y: 300 }], { x: 100, y: 100, width: 200, height: 100 });
      return { box, moved, resized, layers };
    });
    assert.deepEqual(result.box, { x: 0, y: 80, width: 106, height: 340 });
    assert.deepEqual(result.moved, { x: 0, y: 320, width: 200, height: 100 });
    assert.deepEqual(result.resized, { x: 0, y: 0, width: 300, height: 200 });
    assert.equal(result.layers.length, 1); assert.equal(result.layers[0].x, -25); assert.equal(result.layers[0].y, -25);
    assert.deepEqual(result.layers[0].points, [{ x: 0, y: 0 }, { x: 70, y: 40 }]);
  } finally { await page.close(); }
});

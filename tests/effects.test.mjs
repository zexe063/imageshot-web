import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { chromium } from '@playwright/test';

const effectSource = ts.transpileModule(await readFile(new URL('../src/lib/effects.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^export /gm, '');

let browser;
before(async () => {
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ headless: true, channel: 'chrome' }); }
});
after(async () => { await browser?.close(); });

async function fixture() {
  const page = await browser.newPage();
  await page.addScriptTag({ content: `${effectSource}\nwindow.__effects = { drawBlur, drawSpotlights, blurAmount, blurMode };` });
  await page.evaluate(async () => {
    const source = document.createElement('canvas');
    source.width = 160; source.height = 100;
    const ctx = source.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 160, 100);
    ctx.fillStyle = '#000'; ctx.fillRect(80, 0, 80, 100);
    const image = new Image(); image.src = source.toDataURL(); await image.decode();
    window.__image = image;
    window.__render = (annotation, scale = 1) => {
      const canvas = document.createElement('canvas'); canvas.width = 160 * scale; canvas.height = 100 * scale;
      const context = canvas.getContext('2d'); context.scale(scale, scale); context.drawImage(image, 0, 0);
      window.__effects.drawBlur(context, annotation, image);
      return canvas;
    };
    window.__pixel = (canvas, x, y) => [...canvas.getContext('2d').getImageData(x, y, 1, 1).data];
    window.__annotation = { id: 'blur', type: 'blur', x: 20, y: 20, width: 120, height: 60, strokeWidth: 4, color: '#000' };
  });
  return page;
}

test('Blur softens screenshot edges continuously, keeps the selection boundary, and responds to strength', async () => {
  const page = await fixture();
  try {
    const result = await page.evaluate(() => {
      const annotation = { ...window.__annotation, blurMode: 'blur', blurAmount: 12 };
      const canvas = window.__render(annotation);
      const weak = window.__render({ ...annotation, blurAmount: 1 });
      const strong = window.__render({ ...annotation, blurAmount: 24 });
      return {
        edge: [75, 76, 77, 78, 79, 80, 81, 82, 83, 84].map(x => window.__pixel(canvas, x, 50)[0]),
        outside: window.__pixel(canvas, 75, 10),
        weak: window.__pixel(weak, 65, 50)[0], strong: window.__pixel(strong, 65, 50)[0],
      };
    });
    assert.ok(new Set(result.edge).size > 7, 'Gaussian blur creates a smooth gradient rather than square blocks');
    assert.ok(result.edge.every(value => value > 0 && value < 255));
    assert.deepEqual(result.outside, [255, 255, 255, 255], 'pixels beyond the selected region stay intact');
    assert.ok(result.weak > result.strong + 30, 'greater strength spreads the softened edge farther');
  } finally { await page.close(); }
});

test('Saved blur annotations without a mode retain the original pixelation exactly', async () => {
  const page = await fixture();
  try {
    const result = await page.evaluate(() => {
      const old = window.__annotation;
      const rendered = window.__render(old);
      const expected = document.createElement('canvas'); expected.width = 160; expected.height = 100;
      const context = expected.getContext('2d'); context.drawImage(window.__image, 0, 0);
      const small = document.createElement('canvas'); small.width = Math.ceil(old.width / 16); small.height = Math.ceil(old.height / 16);
      small.getContext('2d').drawImage(window.__image, old.x, old.y, old.width, old.height, 0, 0, small.width, small.height);
      context.imageSmoothingEnabled = false;
      context.drawImage(small, 0, 0, small.width, small.height, old.x, old.y, old.width, old.height);
      const explicit = window.__render({ ...old, blurMode: 'pixelate', blurAmount: 16 });
      return { same: rendered.toDataURL() === expected.toDataURL(), explicit: explicit.toDataURL() === expected.toDataURL() };
    });
    assert.deepEqual(result, { same: true, explicit: true });
  } finally { await page.close(); }
});

test('Blur keeps opaque screenshot edges and uses the same strength at export scales', async () => {
  const page = await fixture();
  try {
    const result = await page.evaluate(() => {
      const annotation = { ...window.__annotation, x: 0, y: 0, width: 160, height: 100, blurMode: 'blur', blurAmount: 12 };
      const normal = window.__render(annotation), doubled = window.__render(annotation, 2);
      return {
        corner: window.__pixel(normal, 0, 0),
        samples: [45, 60, 70, 80, 90, 100, 115].map(x => [window.__pixel(normal, x, 50)[0], window.__pixel(doubled, x * 2, 100)[0]]),
      };
    });
    assert.deepEqual(result.corner, [255, 255, 255, 255], 'edge extension prevents transparent or dark halos');
    for (const [normal, doubled] of result.samples) assert.ok(Math.abs(normal - doubled) <= 3, 'doubling export size preserves blur spread');
  } finally { await page.close(); }
});

test('Spotlights keep rectangular and elliptical regions clear with one adjustable surrounding shade', async () => {
  const page = await fixture();
  try {
    const result = await page.evaluate(() => {
      const spot = { ...window.__annotation, type: 'spotlight', x: 20, y: 20, width: 40, height: 40, spotlightDim: 60 };
      const paint = annotations => {
        const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 100;
        const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 160, 100);
        window.__effects.drawSpotlights(context, annotations, 160, 100); return canvas;
      };
      const rectangle = paint([spot]), ellipse = paint([{ ...spot, spotlightShape: 'ellipse' }]);
      const multiple = paint([spot, { ...spot, id: 'second', x: 100, spotlightShape: 'ellipse' }]);
      const hidden = paint([{ ...spot, hidden: true }]);
      const faint = paint([{ ...spot, spotlightDim: 20 }]);
      return {
        rectangleCenter: window.__pixel(rectangle, 40, 40), rectangleCorner: window.__pixel(rectangle, 21, 21),
        ellipseCenter: window.__pixel(ellipse, 40, 40), ellipseCorner: window.__pixel(ellipse, 21, 21),
        outside: window.__pixel(rectangle, 10, 10), faint: window.__pixel(faint, 10, 10),
        first: window.__pixel(multiple, 40, 40), second: window.__pixel(multiple, 120, 40),
        shared: window.__pixel(multiple, 80, 80), hidden: window.__pixel(hidden, 10, 10),
      };
    });
    for (const name of ['rectangleCenter', 'rectangleCorner', 'ellipseCenter', 'first', 'second', 'hidden']) assert.deepEqual(result[name], [255, 255, 255, 255], name);
    for (const name of ['outside', 'ellipseCorner', 'shared']) assert.deepEqual(result[name], [102, 102, 102, 255], name);
    assert.deepEqual(result.faint, [204, 204, 204, 255]);
  } finally { await page.close(); }
});

test('Blur remains visible on maximum-length screenshots without losing their end pixels', async () => {
  const page = await fixture();
  try {
    const result = await page.evaluate(async () => {
      const source = document.createElement('canvas'); source.width = 32760; source.height = 32;
      const sourceContext = source.getContext('2d'); sourceContext.fillStyle = '#fff'; sourceContext.fillRect(0, 0, 32760, 32);
      sourceContext.fillStyle = '#000'; sourceContext.fillRect(16380, 0, 16380, 32);
      const image = new Image(); image.src = source.toDataURL(); await image.decode();
      window.__effects.drawBlur(sourceContext, { ...window.__annotation, x: 0, y: 0, width: 32760, height: 32, blurMode: 'blur', blurAmount: 60 }, image);
      return { first: window.__pixel(source, 0, 16), last: window.__pixel(source, 32759, 16), edge: window.__pixel(source, 16380, 16), spread: window.__pixel(source, 16320, 16) };
    });
    assert.deepEqual(result.first, [255, 255, 255, 255]);
    assert.deepEqual(result.last, [0, 0, 0, 255]);
    assert.ok(result.edge[0] > 80 && result.edge[0] < 175, 'the long image receives a real blur');
    assert.ok(result.spread[0] > 190 && result.spread[0] < 230, 'downsampling retains approximately the requested radius');
  } finally { await page.close(); }
});

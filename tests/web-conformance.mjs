import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, firefox, webkit } from 'playwright-core';
import { syntheticDicomweb } from '../examples/web/dicomweb-fixture.mjs';
import { serve } from './static-server.mjs';

const engine = process.env.RAYKIT_BROWSER ?? 'chromium';
const server = await serve('examples/web/dist', syntheticDicomweb);
let browser;
try {
  browser = await { chromium, firefox, webkit }[engine].launch(engine === 'chromium' ? {
    executablePath: process.env.RAYKIT_CHROMIUM, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  } : {});
  const page = await browser.newPage({ viewport: { width: 980, height: 760 } });
  const pageFailures = [];
  page.on('pageerror', error => pageFailures.push(error.message));
  await page.goto(server.url);
  const viewer = page.locator('raykit-viewer');
  const manifest = JSON.parse(await readFile('fixtures/generated/manifest.json', 'utf8'));
  const codecResults = await viewer.evaluate(async (viewer, manifest) => {
    const result = [];
    for (const [filename, row] of Object.entries(manifest)) {
      if (!filename.startsWith('jpeg-') && !filename.startsWith('htj2k')) continue;
      const response = await fetch(filename);
      await viewer.open(await response.blob(), { expected_sha256: row.sha256 });
      const session = viewer.viewport.session;
      const frame = await session.readFrame(0, { output: 'stored' });
      const pixels = new DataView(frame.pixels.buffer, frame.pixels.byteOffset, frame.pixels.byteLength);
      let maximum = 0;
      row.expected.stored.forEach((sample, index) => { maximum = Math.max(maximum, Math.abs(sample - pixels.getInt32(index * 4, true))); });
      result.push({ filename, maximum, renderer: viewer.viewport.presented.renderer, tolerance: row.expected.tolerance });
    }
    return result;
  }, manifest);
  assert.equal(codecResults.length, 10);
  assert.ok(codecResults.every(result => result.maximum <= result.tolerance));

  await page.locator('[data-fixture="enhanced-ct-oblique.dcm"]').click();
  await page.locator('#build-volume').click();
  await page.waitForFunction(() => document.querySelector('#volume-status').value.includes('3 source slices'));
  await page.locator('#volume-plane').selectOption('Oblique');
  await page.locator('#volume-slab').selectOption('maximum');
  const physical = await viewer.evaluate(viewer => viewer.viewport.session.sampleVolume([-8.86, 7.98, 15.8]));
  assert.equal(physical, 136);
  await page.locator('#read-pr').click();
  await page.waitForFunction(() => document.querySelector('raykit-viewer').viewport.presented.view.quarter_turns === 1);
  await page.locator('#read-seg').click();
  await page.waitForFunction(() => {
    const vp = document.querySelector('raykit-viewer').viewport;
    const { origin, x_axis: a, y_axis: b } = vp.presented.transform;
    const canvas = vp.surface.querySelector('canvas.overlay');
    const x = (origin.x + 4 * a[0] + 2 * b[0]) * canvas.width / vp.surface.clientWidth;
    const y = (origin.y + 4 * a[1] + 2 * b[1]) * canvas.height / vp.surface.clientHeight;
    return canvas.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data[3] === 135;
  });

  const releaseOriginal = Promise.withResolvers();
  const releaseLast = Promise.withResolvers();
  await page.route('**/instances/2.25.913', async route => { await releaseOriginal.promise; await route.continue(); });
  await page.route('**/instances/2.25.912', async route => { await releaseLast.promise; await route.continue(); });
  try {
    await page.locator('#open-dicomweb').click();
    await page.locator('#series-preview').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#series-preview img').naturalWidth === 4);
    assert.equal(await viewer.evaluate(viewer => viewer.viewport.session), undefined);
  } finally { releaseOriginal.resolve(); }
  let inProgress;
  try {
    await page.waitForFunction(() => document.querySelector('#volume-status').value === '2/3 original instances available.');
    inProgress = await viewer.evaluate(async viewer => {
      const vp = viewer.viewport;
      const record = await vp.session.measure(0, { id: 'live-append-distance', method: 'raykit:length', version: 1,
        points: [{ x: 1, y: 1 }, { x: 5, y: 4 }], parameters: { require_mm: true } });
      await viewer.restoreMeasurement(record);
      return { record, revision: vp.presented.revision };
    });
  } finally { releaseLast.resolve(); }
  await page.waitForFunction(() => document.querySelector('#volume-status').value === '3/3 original instances available.');
  assert.equal(await page.locator('#series-preview').isHidden(), true);
  const recordAfterAppend = await viewer.evaluate(async viewer => ({
    record: await viewer.viewport.session.reopenMeasurement(viewer.measurements[0]),
    revision: viewer.viewport.presented.revision,
  }));
  assert.deepEqual(recordAfterAppend, inProgress);
  const series = await viewer.evaluate(async viewer => {
    const session = viewer.viewport.session;
    const result = await session.volumeCandidates();
    return { source: session.inspection.instance_uid, hash: session.inspection.content_sha256, positions: result.candidates[0].frames, available: result.candidates[0].available };
  });
  assert.deepEqual(series, { source: '2.25.913', hash: manifest['classic-ct-2.dcm'].sha256, positions: 3, available: true });

  await page.locator('#share-view').click();
  await page.waitForFunction(() => Array.from(document.querySelector('#shared').querySelectorAll('canvas')).some(canvas => !canvas.hidden));
  await viewer.locator('[data-action=rotate]').click();
  await page.waitForFunction(() => document.querySelector('#shared').dataset.rotation === '1');

  const sr = await viewer.evaluate(async viewer => {
    const session = viewer.viewport.session;
    const record = await session.importSr(await (await fetch('distance-sr.dcm')).blob());
    const blob = await session.exportSr(record, { instance_uid: '2.25.980', series_uid: '2.25.981', tracking_uid: '2.25.982',
      observer_name: 'SYNTHETIC^READER', content_date: '20260101', content_time: '120000' });
    const echoed = await session.importSr(blob);
    return echoed.values[0];
  });
  assert.deepEqual(sr, { name: 'length', value: 5, unit: 'millimeter' });
  const veterinary = await viewer.evaluate(async viewer => {
    const session = viewer.viewport.session;
    const request = { id: 'synthetic-vhs', method: 'raykit:canine-vhs', version: 1,
      points: [[0, 2], [10, 2], [5, 0], [5, 8], [0, 20], [4, 20], [8, 20], [12, 20]].map(([x, y]) => ({ x, y })),
      parameters: { projection: 'lateral_thorax' } };
    const result = await session.measure(0, request);
    await viewer.restoreMeasurement(result);
    return viewer.measurements.at(-1).values;
  });
  assert.deepEqual(veterinary.map(v => v.value), [2.5, 1, 3.5]);

  await page.locator('#live').click();
  await page.waitForFunction(() => document.querySelector('#live-status').value.includes('measurement unavailable'));
  await page.locator('#live').click();
  assert.equal(await page.locator('#live-canvas').evaluate(canvas => canvas.hidden), true);
  assert.deepEqual(pageFailures, []);
  console.log(JSON.stringify({ engine, version: browser.version(), codecResults, physical, series, sr }));
} finally { await browser?.close(); server.close(); }

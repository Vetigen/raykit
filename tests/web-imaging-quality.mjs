import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, firefox, webkit } from 'playwright-core';
import { serve } from './static-server.mjs';

const name = process.env.RAYKIT_BROWSER ?? 'chromium';
const reference = JSON.parse(await readFile('benchmarks/evidence/imaging-reference.json', 'utf8'));
const cases = JSON.parse(await readFile('tests/measurement-cases.json', 'utf8'));
const server = await serve(process.env.RAYKIT_EXAMPLE_DIST ?? 'examples/web/dist', undefined, {
  '/sdk': process.env.RAYKIT_WEB_DIST ?? 'packages/web/dist',
});
let browser;
try {
  browser = await { chromium, firefox, webkit }[name].launch(name === 'chromium' ? {
    executablePath: process.env.RAYKIT_CHROMIUM, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  } : {});
  const page = await browser.newPage({ viewport: { width: 960, height: 820 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url);
  const checks = await page.locator('raykit-viewer').evaluate(async (viewer, { reference, cases }) => {
    const api = await import('/sdk/index.js');
    const blob = file => fetch(`/${file}.dcm`).then(r => r.blob());
    const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
    const pixels = {};
    for (const name of Object.keys(reference.pixel_signatures)) {
      const source = await api.open(await blob(name));
      try {
        const stored = await source.readFrame(0, { output: 'stored' });
        pixels[name] = { stored_sha256: await hash(stored.pixels), rgba_sha256: await hash(await source.render(0, {})) };
      } finally { source.close(); }
    }
    let ybrDelta = 0;
    const ybr = await api.open(await blob('us-ybr-422'));
    try {
      const rgb = await ybr.render(0, {});
      reference.ybr422_rgb.forEach((pixel, i) => pixel.forEach((sample, c) => {
        ybrDelta = Math.max(ybrDelta, Math.abs(sample - rgb[i * 4 + c]));
      }));
    } finally { ybr.close(); }
    const lut = {};
    for (const name of Object.keys(reference.lut_values)) {
      const source = await api.open(await blob(name));
      try { lut[name] = Array.from(await source.render(0, {})).filter((_, i) => i % 4 === 0); }
      finally { source.close(); }
    }
    await viewer.open(await blob('signed12'), { revision: 'pinned-radiograph' });
    const controls = viewer.viewport;
    const session = controls.session;
    const measurements = [];
    for (const row of cases) {
      const record = await session.measure(0, { id: row.id, method: row.method, version: 1, parameters: row.parameters,
        points: row.points.map(([x, y]) => ({ x, y })) });
      const restored = await viewer.restoreMeasurement(JSON.parse(JSON.stringify(record)));
      measurements.push({ source: restored.source, coordinate_system: restored.coordinate_system,
        method: restored.input.method, version: restored.input.version, units: restored.values.map(v => v.unit),
        values: restored.values.map(v => v.value) });
    }
    controls.setView({ pan: [9, -11], zoom: 1.6, quarter_turns: 1 });
    await controls.redraw();
    const { x_axis: x, y_axis: y, origin: p } = controls.presented.transform;
    const match = await controls.mapPoint({ x: p.x + 10 * x[0] + 12 * y[0], y: p.y + 10 * x[1] + 12 * y[1] });
    const geometry = [];
    for (const name of ['us-gray-time', 'dx-luts']) {
      const source = await api.open(await blob(name));
      try {
        await source.measure(0, { id: name, method: 'raykit:length', version: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], parameters: { require_mm: true } });
        geometry.push('unexpected success');
      } catch (error) { geometry.push(error.code); }
      finally { source.close(); }
    }
    await viewer.open(await blob('detail-signed12'));
    let details = null;
    if (controls.presented.renderer === 'webgl2') {
      const canvas = document.createElement('canvas');
      const frame = controls.frame;
      const { columns, rows } = frame.format;
      canvas.width = columns; canvas.height = rows;
      const display = new api.WebGlRenderer(canvas);
      try {
        const options = { window: { center: -1500, width: 4, function: 'linear_exact' }, palette: 'hot' };
        if (!display.draw(frame, { origin: { x: .5, y: .5 }, x_axis: [1, 0], y_axis: [0, 1] }, [columns, rows], options)) throw Error('Detail chart shader did not draw');
        const rgba = await controls.session.render(0, options);
        const presented = display.capture();
        let max = 0;
        for (let row = 0; row < rows; row++) for (let x = 0; x < columns * 4; x++) {
          max = Math.max(max, Math.abs(rgba[row * columns * 4 + x] - presented[(rows - 1 - row) * columns * 4 + x]));
        }
        details = max;
      } finally { display.dispose(); }
    }
    return { pixels, measurements, mapped: match.pixel, geometry, details, ybrDelta, lut,
      renderer: controls.presented.renderer, isolated: crossOriginIsolated };
  }, { reference, cases });
  assert.deepEqual(checks.pixels, reference.pixel_signatures);
  assert.ok(checks.ybrDelta <= 1);
  assert.deepEqual(checks.lut, reference.lut_values);
  for (const [i, row] of checks.measurements.entries()) {
    const expected = cases[i];
    assert.equal(row.source.instance_uid, '2.25.101');
    assert.equal(row.source.sop_class_uid, '1.2.840.10008.5.1.4.1.1.1');
    assert.equal(row.source.frame, 0);
    assert.equal(row.coordinate_system, 'source_pixel_centers');
    assert.equal(row.method, expected.method);
    assert.equal(row.version, 1);
    assert.deepEqual(row.units, expected.units);
    assert.ok(row.values.every((v, j) => Math.abs(v - expected.values[j]) <= 1e-12));
  }
  assert.deepEqual(checks.geometry, ['geometry', 'geometry']);
  assert.ok(Math.abs(checks.mapped.x - 10) < 1e-10 && Math.abs(checks.mapped.y - 12) < 1e-10);
  assert.equal(checks.isolated, false);
  if (checks.renderer === 'webgl2') assert.ok(checks.details <= 1);
  await page.locator('[data-fixture="large-enhanced-mr.dcm"]').click();
  await page.locator('#build-volume').click();
  await page.waitForFunction(() => document.querySelector('#volume-status').value.includes('300 source slices'));
  await page.locator('#volume-plane').selectOption('Sagittal');
  await page.waitForFunction(() => document.querySelector('#volume-status').value.startsWith('sagittal'));
  const volume = await page.locator('raykit-viewer').evaluate(async viewer => {
    const session = viewer.viewport.session;
    return { value: await session.sampleVolume([179.2, 204.8, 180]), stats: await session.stats() };
  });
  assert.equal(volume.value, 448);
  assert.ok(volume.stats.volume.peak_slice_cache_bytes <= 16 * 1024 ** 2);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ engine: name, version: browser.version(), ...checks, volume }, null, 2));
} finally { await browser?.close(); server.close(); }

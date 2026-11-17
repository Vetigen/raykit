import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, firefox } from 'playwright-core';
import { serve } from './static-server.mjs';

const server = await serve('examples/web/dist');
const engine = process.env.RAYKIT_BROWSER ?? 'chromium';
let browser;
try {
  browser = await { chromium, firefox }[engine].launch(engine === 'chromium'
    ? { executablePath: process.env.RAYKIT_CHROMIUM, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] } : {});
  const page = await browser.newPage({ viewport: { width: 1050, height: 750 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url);
  await page.evaluate(() => {
    window.presentedFrames = [];
    window.addEventListener('raykit-presented', event => window.presentedFrames.push(event.detail));
  });
  const viewer = page.locator('raykit-viewer');
  await viewer.locator('input[data-file]').setInputFiles('fixtures/generated/signed12.dcm');
  await page.waitForFunction(() => window.presentedFrames.length > 0);
  const first = await page.evaluate(() => window.presentedFrames.at(-1));
  assert.equal(first.source.frame, 0);
  assert.equal(first.quality, 'original');
  assert.ok(['webgl2', 'cpu'].includes(first.renderer));
  assert.equal(await page.evaluate(() => crossOriginIsolated), false);
  const sample = await viewer.evaluate(viewer => viewer.viewport.session.sample(0, 10, 10));
  assert.deepEqual(sample, { kind: 'monochrome', stored: -1540, modality: -3180, padding: false });

  await viewer.locator('[data-tool]').selectOption('length');
  const screen = await viewer.evaluate(viewer => {
    const transform = viewer.viewport.presented.transform;
    const surface = viewer.viewport.surface;
    const rect = surface.getBoundingClientRect();
    return [[3, 5], [9, 21]].map(([x, y]) => ({
      x: rect.x + surface.clientLeft + transform.origin.x + transform.x_axis[0] * x + transform.y_axis[0] * y,
      y: rect.y + surface.clientTop + transform.origin.y + transform.x_axis[1] * x + transform.y_axis[1] * y,
    }));
  });
  for (const p of screen) await page.mouse.click(p.x, p.y);
  await viewer.locator('[data-action=measure]').click();
  await page.waitForFunction(() => document.querySelector('raykit-viewer').measurements.length === 1);
  const record = (await viewer.evaluate(viewer => viewer.measurements))[0];
  assert.equal(record.values[0].unit, 'millimeter');
  assert.ok(Math.abs(record.values[0].value - 5) < 0.15);
  await viewer.locator('[data-action=rotate]').click();
  await page.waitForFunction(() => window.presentedFrames.at(-1).view.quarter_turns === 1);
  assert.deepEqual((await viewer.evaluate(viewer => viewer.measurements))[0], record);

  await viewer.evaluate(async viewer => {
    const vp = viewer.viewport;
    vp.setRenderOptions({ window: { center: -3180, width: 2, function: 'linear_exact' } });
    await vp.redraw();
  });
  const before = await viewer.evaluate(viewer => viewer.viewport.session.stats());
  assert.equal(before.session.decoded_frames, 1);
  await viewer.locator('input[data-file]').setInputFiles('fixtures/generated/signed12.dcm');
  await page.waitForFunction(() => {
    const viewer = document.querySelector('raykit-viewer');
    return viewer.viewport?.presented?.view.quarter_turns === 0 && viewer.measurements.length === 0;
  });
  const reopened = await viewer.evaluate((viewer, record) => viewer.restoreMeasurement(record), record);
  assert.ok(Math.abs(reopened.values[0].value - record.values[0].value) < 1e-10);

  await viewer.locator('[data-action=new]').click();
  await viewer.locator('input[data-file]').setInputFiles('fixtures/generated/cine-350.dcm');
  await page.waitForFunction(() => document.querySelector('raykit-viewer').viewport?.presented?.source.frame === 0);
  const manifest = JSON.parse(await readFile('fixtures/generated/manifest.json', 'utf8'))['cine-350.dcm'];
  const cine = await viewer.evaluate(async (viewer, reference) => {
    const vp = viewer.viewport;
    const session = vp.session;
    const data = [];
    for (const index of [0, 175, 349]) {
      const initial = (await session.stats()).session.decoded_frames;
      const started = performance.now();
      await vp.showFrame(index, false);
      const milliseconds = performance.now() - started;
      const sample = await session.sample(index, 0, 0);
      data.push({ index: vp.presented.source.frame, milliseconds, sample,
        decoded: (await session.stats()).session.decoded_frames - initial });
    }
    const pending = [5, 60, 8, 349].map(index => vp.showFrame(index, false));
    const seeks = (await Promise.allSettled(pending)).map(result => result.status === 'rejected' ? result.reason.code : result.status);
    return { data, seeks, latest: vp.presented.source.frame, hash: vp.presented.source.content_sha256,
      stats: await session.stats(), gpuTextureEstimate: vp.textureBytes, verifiedReference: reference };
  }, manifest.sha256);
  assert.equal(cine.hash, cine.verifiedReference);
  for (const { index, sample, decoded } of cine.data) {
    assert.equal(sample.kind, 'color');
    sample.values.forEach((v, i) => assert.ok(Math.abs(v - manifest.expected.rgb_at_0_0[index][i]) <= manifest.expected.tolerance));
    assert.equal(decoded, index === 0 ? 0 : 1);
  }
  assert.equal(cine.latest, 349);
  assert.deepEqual(cine.seeks, ['cancelled', 'cancelled', 'cancelled', 'fulfilled']);
  assert.ok(cine.stats.session.cached_frames <= 2);
  assert.ok(cine.stats.wasm_linear_memory_bytes < 256 * 1024 * 1024);
  if (first.renderer === 'webgl2') {
    await viewer.evaluate(viewer => {
      const gl = viewer.viewport.surface.querySelector('canvas:not([hidden]):not(.overlay)').getContext('webgl2');
      gl.getExtension('WEBGL_lose_context').loseContext();
    });
  }
  await page.waitForFunction(() => window.presentedFrames.at(-1).renderer === 'cpu');
  assert.equal(await viewer.evaluate(viewer => viewer.viewport.presented.source.frame), 349);

  for (const filename of ['signed12-deflated.dcm', 'cine-extended.dcm']) {
    await viewer.locator('[data-action=new]').click();
    await viewer.evaluate(async (viewer, filename) => viewer.open(await (await fetch(filename)).blob()), filename);
  }
  assert.equal(await viewer.locator('.surface').count(), 4);
  assert.equal(await viewer.locator('[data-action=new]').isDisabled(), true);
  const retired = await viewer.evaluate(async (viewer, sha256) => {
    const prior = viewer.viewport.session;
    const observations = window.presentedFrames.length;
    let reading;
    const started = new Promise(resolve => { reading = resolve; });
    const abandoned = viewer.open({
      read(signal) {
        reading();
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Reader aborted')), { once: true }));
      },
    }, { revision: 'cancelled-reader' }).then(() => 'opened', error => error.code);
    await started;
    const radiograph = await (await fetch('signed12.dcm')).blob();
    const rejected = await viewer.open(radiograph, { expected_sha256: '0'.repeat(64) }).then(() => 'opened', error => error.code);
    await viewer.open(radiograph, { expected_sha256: sha256, revision: 'original' });
    return { cancelled: await abandoned, rejected, retained: viewer.viewport.presented.revision,
      old: await prior.stats().then(() => 'open', error => error.code),
      observedStale: window.presentedFrames.slice(observations).some(event => event.revision === 'cancelled-reader') };
  }, JSON.parse(await readFile('fixtures/generated/manifest.json', 'utf8'))['signed12.dcm'].sha256);
  assert.deepEqual(retired, { cancelled: 'cancelled', rejected: 'integrity', retained: 'original', old: 'closed', observedStale: false });
  await viewer.evaluate(viewer => {
    window.removedViewport = viewer.viewport;
    window.removedSession = viewer.viewport.session;
  });
  await viewer.locator('[data-action=close]').click();
  assert.deepEqual(await page.evaluate(async () => ({
    texture: window.removedViewport.textureBytes,
    session: await window.removedSession.stats().then(() => 'open', error => error.code),
  })), { texture: 0, session: 'closed' });
  await viewer.locator('.surface').nth(1).focus();
  assert.equal(await viewer.evaluate(viewer => viewer.viewport.presented.source.frame), 349);
  await viewer.locator('.surface').first().focus();
  assert.deepEqual((await viewer.evaluate(viewer => viewer.measurements))[0], reopened);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ engine, browser: browser.version(), crossOriginIsolated: false, xray: first.renderer, measurement: record.values[0], cine,
    four_panel_lifecycle: retired }, null, 2));
} finally { await browser?.close(); server.close(); }

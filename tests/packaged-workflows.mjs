import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { serve } from './static-server.mjs';

const root = resolve('.');
const tree = mkdtempSync(join(tmpdir(), 'raykit-consumer-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const web = join(tree, 'examples/web');
const flutter = join(tree, 'examples/flutter');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && command === npm });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} exited with ${result.status}`);
}

function copy(path) {
  const output = join(tree, path);
  mkdirSync(join(output, '..'), { recursive: true });
  cpSync(join(root, path), output, { recursive: true });
}

function assertNotices(directory) {
  const inventory = JSON.parse(readFileSync(join(directory, 'inventory.json'), 'utf8'));
  for (const name of ['dicom-core', 'dicom-dictionary-std', 'jpeg-decoder', 'oxiarc-jpeg', 'pure_jpegls', 'openjpeg2-pure-rs']) {
    const crate = inventory.find(crate => crate.name === name);
    assert.ok(crate?.license && crate.documents.length, `Missing license files for ${name}`);
    for (const file of crate.documents) assert.ok(existsSync(join(directory, file)));
  }
  assert.ok(!inventory.some(crate => crate.name.startsWith('openjph') || crate.name === 'jpeg-encoder'));
}

try {
  for (const path of ['tsconfig.base.json', 'examples/web/package.json', 'examples/web/tsconfig.json', 'examples/web/vite.config.mjs',
    'examples/web/dicomweb-fixture.mjs', 'examples/web/index.html', 'examples/web/src', 'fixtures/generated']) copy(path);
  run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund',
    join(root, 'artifacts/raykit-web-0.1.0.tgz'), join(root, 'artifacts/raykit-web-component-0.1.0.tgz'), 'vite@7.3.1', 'typescript@5.9.3'], web);
  assertNotices(join(web, 'node_modules/@raykit/web/dist/notices'));
  run(npm, ['run', 'build'], web);
  const service = await serve(join(web, 'dist'));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.RAYKIT_CHROMIUM, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
    const page = await browser.newPage();
    await page.goto(service.url);
    await page.locator('[data-fixture="signed12.dcm"]').click();
    await page.waitForFunction(() => document.querySelector('raykit-viewer')?.viewport?.presented?.source.frame === 0);
    const result = await page.locator('raykit-viewer').evaluate(async viewer => {
      const session = viewer.viewport.session;
      const sample = await session.sample(0, 10, 10);
      const measure = await session.measure(0, { id: 'packaged-distance', method: 'raykit:length', version: 1,
        points: [{ x: 0, y: 0 }, { x: 6, y: 16 }] });
      await viewer.restoreMeasurement(measure);
      return { stored: sample.stored, values: viewer.measurements[0].values, supported: session.inspection.capabilities.frame_access };
    });
    assert.deepEqual(result, { stored: -1540, values: [{ name: 'length', value: 5, unit: 'millimeter' }], supported: true });
    await page.locator('[data-fixture="cine-350.dcm"]').click();
    await page.waitForFunction(() => document.querySelector('raykit-viewer')?.viewport?.session?.inspection.frames === 350 &&
      document.querySelector('raykit-viewer')?.viewport?.presented?.source.frame === 0);
    const last = await page.locator('raykit-viewer').evaluate(async viewer => {
      const viewport = viewer.viewport;
      await viewport.showFrame(349, false);
      return viewport.presented.source.frame;
    });
    assert.equal(last, 349);
  } finally { await browser?.close(); service.close(); }

  for (const path of ['examples/flutter/pubspec.yaml', 'examples/flutter/analysis_options.yaml', 'examples/flutter/lib',
    'examples/flutter/test', 'examples/flutter/assets/raykit']) copy(path);
  mkdirSync(join(tree, 'packages'));
  run('tar', ['-xzf', join(root, 'artifacts/raykit-flutter-0.1.0.tar.gz')], join(tree, 'packages'));
  renameSync(join(tree, 'packages/raykit'), join(tree, 'packages/flutter'));
  assertNotices(join(tree, 'packages/flutter/notices'));
  run('flutter', ['pub', 'get'], flutter);
  run('flutter', ['test', '--no-pub', '--concurrency=1', 'test/example_test.dart'], flutter);
  console.log('Independent web and Flutter package consumers passed.');
} finally { rmSync(tree, { recursive: true, force: true }); }

import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { platform, release, cpus, totalmem } from 'node:os';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium, firefox, webkit } from 'playwright-core';
import { serve } from '../tests/static-server.mjs';

const compressed = promisify(gzip);
const repetitions = Number(process.env.RAYKIT_REPEATS ?? 5);
const cineRepetitions = Number(process.env.RAYKIT_CINE_REPEATS ?? 3);
const browserName = process.env.RAYKIT_BROWSER ?? 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
assert.ok(browserType, `Unknown benchmark browser ${browserName}`);
const selected = (process.env.RAYKIT_ENGINES ?? (browserName === 'chromium' ? 'raykit,webgpu,dwv,cornerstone' : 'raykit,dwv,cornerstone')).split(',');
assert.ok(Number.isSafeInteger(repetitions) && repetitions > 0 && Number.isSafeInteger(cineRepetitions) && cineRepetitions > 0);
const manifest = JSON.parse(await readFile('fixtures/generated/manifest.json', 'utf8'));
const service = await serve('benchmarks/dist');
const raw = [];
const args = browserName === 'chromium' ? ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--enable-precise-memory-info', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--disable-vulkan-surface'] : [];

function metrics(values) {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const p = q => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
  const median = (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
  return { n: sorted.length, median, p95: p(0.95), maximum: sorted.at(-1) };
}

async function browserMemory(cdp) {
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  const measurements = await Promise.all(processInfo.map(async process => {
    if (!['renderer', 'GPU', 'browser'].includes(process.type)) return null;
    const text = await readFile(`/proc/${process.id}/status`, 'utf8').catch(() => '');
    const rss = /^VmRSS:\s+(\d+)/m.exec(text);
    return rss ? [process.type, Number(rss[1]) * 1024] : null;
  }));
  const byteCounts = {};
  for (const value of measurements) if (value) byteCounts[value[0]] = (byteCounts[value[0]] ?? 0) + value[1];
  return byteCounts;
}

async function run(browser, cdp, backend, fixture, checkReference) {
  const page = await browser.newPage({ viewport: { width: 640, height: 512 }, deviceScaleFactor: 1 });
  let peak = {};
  let timer;
  let poll;
  let crashed = false;
  page.on('crash', () => { crashed = true; });
  try {
    const memory = () => cdp ? browserMemory(cdp).catch(() => ({})) : {};
    const baseline = await memory();
    const sample = async () => {
      const values = await memory();
      for (const [kind, bytes] of Object.entries(values)) peak[kind] = Math.max(peak[kind] ?? 0, bytes);
    };
    if (cdp) poll = setInterval(() => void sample(), 50);
    await page.goto(service.url);
    await page.waitForFunction(() => typeof window.runRaykitBenchmark === 'function');
    const result = await Promise.race([page.evaluate(async ({ backend, fixture, manifest }) => {
      const cold = await window.runRaykitBenchmark(backend, fixture, manifest, { full: true });
      const warm = cold.opened ? await window.runRaykitBenchmark(backend, fixture, manifest, { full: false }) : undefined;
      return { cold, warm };
    }, { backend, fixture, manifest: manifest[fixture] }), new Promise(resolve => {
      timer = setTimeout(() => resolve({ cold: { opened: false, error: 'Scenario exceeded 45-second run limit' } }), 45_000);
    })]).catch(error => ({ cold: { opened: false, error: crashed ? 'Browser page crashed during the scenario' : error.message } }));
    const quality = result.cold.backend === 'RayKit webgl2' && fixture.startsWith('benchmark-') && checkReference
      ? await page.evaluate(() => window.verifyRaykitGpu()) : undefined;
    await sample();
    return { backend, fixture, quality, baseline_rss_bytes: baseline, sampled_peak_rss_bytes: peak, ...result };
  } finally { clearInterval(poll); clearTimeout(timer); await page.close(); }
}

let browserVersion;
try {
  for (const backend of selected) {
    if (!['raykit', 'webgpu', 'dwv', 'cornerstone'].includes(backend)) throw new Error(`Unknown benchmark engine ${backend}`);
    for (const fixture of ['benchmark-signed12.dcm', 'cine-350.dcm']) {
      if (backend === 'webgpu' && fixture === 'cine-350.dcm') continue;
      const count = fixture === 'cine-350.dcm' ? cineRepetitions : repetitions;
      for (let i = 0; i < count; i++) {
        const browser = await browserType.launch({ executablePath: browserName === 'chromium' ? process.env.RAYKIT_CHROMIUM : undefined, args });
        browserVersion = browser.version();
        try {
          const cdp = browserName === 'chromium' && platform() === 'linux' ? await browser.newBrowserCDPSession() : undefined;
          const result = await run(browser, cdp, backend, fixture, i === 0);
          if (result.quality) {
            assert.ok(result.quality.maximum <= 1);
            assert.ok(result.quality.interpolation.every(({ expected, actual }) => Math.abs(expected - actual) <= 1));
          }
          raw.push(result);
          process.stdout.write(`${backend} ${fixture} ${i + 1}/${count} ${result.cold.error ?? result.warm?.error ?? 'completed'}\n`);
        } catch (error) {
          raw.push({ backend, fixture, cold: { opened: false, error: error.message } });
          process.stdout.write(`${backend} ${fixture} ${i + 1}/${count} failed: ${error.message}\n`);
        } finally { await browser.close(); }
      }
    }
  }
} finally { service.close(); }

const summary = [];
for (const backend of selected) for (const fixture of ['benchmark-signed12.dcm', 'cine-350.dcm']) {
  const results = raw.filter(r => r.backend === backend && r.fixture === fixture);
  if (!results.length) continue;
  const completed = results.filter(r => r.cold.opened);
  const all = (run, key) => completed.flatMap(r => r[run]?.[key] ?? []);
  const interactions = {};
  for (const kind of ['window', 'pan_zoom', 'seek']) {
    const rows = completed.flatMap(r => r.cold.interaction?.[kind] ?? []);
    if (rows.length) interactions[kind] = { input_ms: metrics(rows.flatMap(r => r.input_latency_ms)),
      interval_ms: metrics(rows.flatMap(r => r.present_interval_ms)), missed_60hz: rows.reduce((n, r) => n + r.estimated_missed_60hz, 0) };
  }
  const playback = completed.flatMap(r => r.cold.interaction?.cine ?? []);
  if (playback.length) interactions.cine = { shown: metrics(playback.map(r => r.shown)), dropped: metrics(playback.map(r => r.dropped)),
    interval_ms: metrics(playback.flatMap(r => r.intervals_ms)) };
  summary.push({ backend, fixture, successful: completed.length, warm_successful: completed.filter(r => r.warm?.opened).length, attempts: results.length,
    cold_first_original_ms: metrics(all('cold', 'first_original_ms')), warm_first_original_ms: metrics(all('warm', 'first_original_ms')),
    cold_module_ms: metrics(all('cold', 'module_ms')), warm_module_ms: metrics(all('warm', 'module_ms')),
    cold_source_ms: metrics(all('cold', 'source_ms')), warm_source_ms: metrics(all('warm', 'source_ms')),
    cold_full_series_ms: metrics(all('cold', 'full_series_ms')), warm_full_series_ms: metrics(all('warm', 'full_series_ms')),
    reported_first_frame_work_ms: metrics(all('cold', 'first_original').flatMap(r => r.reported_frame_work_ms ?? [])),
    seek_present_ms: metrics(all('cold', 'seek').map(r => r.presented_ms)),
    peak_sampled_renderer_rss: metrics(completed.flatMap(r => r.sampled_peak_rss_bytes?.renderer ?? [])),
    interactions, failures: [...new Set(results.flatMap(r => [r.cold.error, r.warm?.error].filter(Boolean)))] });
}
const assetSizes = [];
for (const name of await readdir('benchmarks/dist/assets', { recursive: true })) {
  const path = `benchmarks/dist/assets/${name}`;
  if (!(await stat(path)).isFile()) continue;
  const bytes = await readFile(path);
  assetSizes.push({ name, bytes: bytes.length, gzip_bytes: (await compressed(bytes)).length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
function git(args) {
  try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}
const result = { profile: { checkout_revision: git(['rev-parse', 'HEAD']), platform: platform(), release: release(), cpu: cpus()[0]?.model, totalMemory: totalmem(),
  measurement: 'first-original-draw-event',
  browser: browserName, browserVersion, flags: args, viewport_px: [640, 512], deviceScaleFactor: 1, repeats: repetitions, cineRepeats: cineRepetitions,
  versions: { dwv: '0.36.4', cornerstone3d: '5.19.4', jpeg_decoder: '0.3.2',
    oxiarc_jpeg: '0.4.2', pure_jpegls: '2.1.0', openjpeg2_pure_rs: '0.1.1' },
  wasmVariant: process.env.RAYKIT_WASM_VARIANT ?? 'full', isolated: false },
  fixture_hashes: Object.fromEntries(['benchmark-signed12.dcm', 'cine-350.dcm'].map(f => [f, manifest[f].sha256])),
  assetSizes, summary, raw };
await mkdir('benchmarks/results', { recursive: true });
await writeFile('benchmarks/results/compare.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(summary, null, 2));

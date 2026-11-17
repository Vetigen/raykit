import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { platform, release, cpus, totalmem } from 'node:os';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { serve } from '../tests/static-server.mjs';

const compressed = promisify(gzip);
const repetitions = Number(process.env.RAYKIT_REPEATS ?? 5);
const cineRepetitions = Number(process.env.RAYKIT_CINE_REPEATS ?? 3);
const selected = (process.env.RAYKIT_ENGINES ?? 'raykit,webgpu,dwv,cornerstone').split(',');
assert.ok(Number.isSafeInteger(repetitions) && repetitions > 0 && Number.isSafeInteger(cineRepetitions) && cineRepetitions > 0);
const manifest = JSON.parse(await readFile('fixtures/generated/manifest.json', 'utf8'));
const service = await serve('benchmarks/dist');
const raw = [];
const args = ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-precise-memory-info',
  '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--disable-vulkan-surface'];

function metrics(values) {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const p = q => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
  return { n: sorted.length, median: p(0.5), p95: p(0.95), maximum: sorted.at(-1) };
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

async function run(browser, cdp, backend, fixture, full) {
  const page = await browser.newPage({ viewport: { width: 640, height: 512 }, deviceScaleFactor: 1 });
  let peak = {};
  let timer;
  let poll;
  try {
    const baseline = await browserMemory(cdp).catch(() => ({}));
    const sample = async () => {
      const values = await browserMemory(cdp).catch(() => ({}));
      for (const [kind, bytes] of Object.entries(values)) peak[kind] = Math.max(peak[kind] ?? 0, bytes);
    };
    poll = setInterval(() => void sample(), 50);
    await page.goto(service.url);
    await page.waitForFunction(() => typeof window.runRaykitBenchmark === 'function');
    const quality = backend === 'raykit' && fixture.startsWith('benchmark-') && full
      ? await page.evaluate(() => window.verifyRaykitGpu()) : undefined;
    const result = await Promise.race([page.evaluate(async ({ backend, fixture, manifest, full }) => {
      const cold = await window.runRaykitBenchmark(backend, fixture, manifest, { full });
      const warm = cold.opened ? await window.runRaykitBenchmark(backend, fixture, manifest, { full: false }) : undefined;
      return { cold, warm };
    }, { backend, fixture, manifest: manifest[fixture], full }), new Promise(resolve => {
      timer = setTimeout(() => resolve({ cold: { opened: false, error: 'Scenario exceeded 45-second run limit' } }), 45_000);
    })]);
    await sample();
    return { backend, fixture, quality, baseline_rss_bytes: baseline, sampled_peak_rss_bytes: peak, ...result };
  } finally { clearInterval(poll); clearTimeout(timer); await page.close(); }
}

let chromeVersion;
try {
  for (const backend of selected) {
    if (!['raykit', 'webgpu', 'dwv', 'cornerstone'].includes(backend)) throw new Error(`Unknown benchmark engine ${backend}`);
    for (const fixture of ['benchmark-signed12.dcm', 'cine-350.dcm']) {
      if (backend === 'webgpu' && fixture === 'cine-350.dcm') continue;
      const count = fixture === 'cine-350.dcm' ? cineRepetitions : repetitions;
      for (let i = 0; i < count; i++) {
        const browser = await chromium.launch({ executablePath: process.env.RAYKIT_CHROMIUM, args });
        chromeVersion = browser.version();
        try {
          const cdp = await browser.newBrowserCDPSession();
          const result = await run(browser, cdp, backend, fixture, i === 0);
          raw.push(result);
          process.stdout.write(`${backend} ${fixture} ${i + 1}/${count} ${result.cold.opened ? 'completed' : result.cold.error}\n`);
          if (result.quality) {
            assert.ok(result.quality.maximum <= 1);
            assert.ok(result.quality.interpolation.every(({ expected, actual }) => Math.abs(expected - actual) <= 1));
          }
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
  summary.push({ backend, fixture, successful: completed.length, attempts: results.length,
    cold_present_ms: metrics(all('cold', 'first_ms')), warm_present_ms: metrics(all('warm', 'first_ms')),
    cold_module_ms: metrics(all('cold', 'module_ms')), cold_open_ms: metrics(all('cold', 'frame_open_ms')),
    seek_present_ms: metrics(all('cold', 'seek').map(r => r.presented_ms)),
    peak_sampled_renderer_rss: metrics(completed.flatMap(r => r.sampled_peak_rss_bytes?.renderer ?? [])),
    interactions, failures: [...new Set(results.flatMap(r => r.cold.error ?? []))] });
}
const assetSizes = [];
for (const name of await readdir('benchmarks/dist/assets')) {
  const path = `benchmarks/dist/assets/${name}`;
  if (!(await stat(path)).isFile()) continue;
  const bytes = await readFile(path);
  assetSizes.push({ name, bytes: bytes.length, gzip_bytes: (await compressed(bytes)).length });
}
const revision = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return 'working tree before first commit'; } })();
const result = { profile: { revision, platform: platform(), release: release(), cpu: cpus()[0]?.model, totalMemory: totalmem(),
  chromeVersion, flags: args, viewport_px: [640, 512], deviceScaleFactor: 1, repeats: repetitions, cineRepeats: cineRepetitions,
  versions: { dwv: '0.36.4', cornerstone3d: '5.19.4', jpeg_decoder: '0.3.2' }, isolated: false },
  fixture_hashes: Object.fromEntries(['benchmark-signed12.dcm', 'cine-350.dcm'].map(f => [f, manifest[f].sha256])),
  assetSizes, summary, raw };
await mkdir('benchmarks/results', { recursive: true });
await writeFile('benchmarks/results/compare.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(summary, null, 2));

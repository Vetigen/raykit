import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cpus, release, totalmem } from 'node:os';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

const binary = resolve(process.env.RAYKIT_FLUTTER_LINUX ?? 'examples/flutter/build/linux/x64/profile/bundle/raykit_example');
const deadline = Number(process.env.RAYKIT_PROFILE_TIMEOUT_SECONDS ?? 720);
assert(Number.isFinite(deadline) && deadline > 0);
async function observe(executable, fixture) {
  const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1024x768x24', executable], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env, LIBGL_ALWAYS_SOFTWARE: '1',
      ...(fixture ? { RAYKIT_STARTUP_FIXTURE: fixture, RAYKIT_STARTUP_SOURCE_DIR: resolve('fixtures/generated') } : {}),
    },
  });
  const sections = new Map();
  const lines = createInterface({ input: child.stdout });
  const close = () => {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  process.once('SIGTERM', close);
  let timer;
  try {
    const report = await new Promise((done, reject) => {
      timer = setTimeout(() => reject(new Error('Flutter profile deadline elapsed')), deadline * 1000);
      child.on('error', reject);
      child.on('exit', code => reject(new Error('Flutter profile exited with ' + code)));
      lines.on('line', line => {
        const match = /^RAYKIT_ACCEPTANCE (\d+)\/(\d+) (.*)$/.exec(line);
        if (!match) return;
        const index = Number(match[1]);
        const count = Number(match[2]);
        if (count < 1 || count > 128 || index < 1 || index > count) return;
        sections.set(index, match[3]);
        if (sections.size !== count) return;
        try { done(JSON.parse(Array.from({ length: count }, (_, i) => sections.get(i + 1)).join(''))); }
        catch (error) { reject(error); }
      });
    });
    if (report.observations.error) throw new Error(report.observations.error);
    return report;
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGTERM', close);
    lines.close();
    close();
  }
}

const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const artifactDigests = executable => ({ runner: hash(executable), app: hash(resolve(executable, '../lib/libapp.so')) });
const flutter = JSON.parse(execFileSync('flutter', ['--version', '--machine'], { encoding: 'utf8' }));
delete flutter.flutterRoot;
if (process.argv.includes('--startup')) {
  assert(process.env.RAYKIT_FLUTTER_BASELINE, 'Set RAYKIT_FLUTTER_BASELINE to the installed reference app');
  const repetitions = Number(process.env.RAYKIT_STARTUP_REPEATS ?? 20);
  assert(Number.isSafeInteger(repetitions) && repetitions > 0);
  const paths = { baseline: resolve(process.env.RAYKIT_FLUTTER_BASELINE), candidate: binary };
  const observations = [];
  for (const fixture of ['benchmark-signed12.dcm', 'cine-350.dcm']) {
    for (let trial = 0; trial < repetitions; trial++) {
      for (const variant of trial % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        const run = await observe(paths[variant], fixture);
        assert.equal(run.observations.startup.fixture, fixture);
        const opens = run.observations.startup.opens;
        assert.equal(opens.length, 11);
        if (variant === 'candidate') for (const row of opens) {
          assert(['worker_start_us', 'worker_open_us', 'file_read_us', 'hash_us', 'parse_us', 'frame_read_us', 'frame_draw_us']
            .every(key => Number.isFinite(row.timing[key]) && row.timing[key] >= 0), 'Missing candidate timing');
        }
        observations.push({ trial, variant, fixture, ...run });
      }
    }
  }
  const metrics = numbers => {
    const sorted = numbers.toSorted((a, b) => a - b);
    return sorted.length ? { n: sorted.length, p50: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2,
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1] } : null;
  };
  const summary = [];
  for (const fixture of ['benchmark-signed12.dcm', 'cine-350.dcm']) for (const variant of Object.keys(paths)) {
    const trials = observations.filter(row => row.variant === variant && row.fixture === fixture);
    const stats = trials.map(row => row.observations.startup);
    summary.push({
      fixture, variant,
      first_original_ms: metrics(stats.map(row => row.opens[0].first_original_us / 1000)),
      reopen_ms: metrics(stats.flatMap(row => row.opens.slice(1).map(open => open.first_original_us / 1000))),
      seek_ms: metrics(stats.flatMap(row => row.seek_ms)),
      sampled_peak_rss_bytes: metrics(trials.map(row => row.observations.rss.sampled_peak_bytes)),
      after_last_close_rss_bytes: metrics(stats.map(row => row.rss_after_close_bytes.at(-1))),
      cold_phases_ms: Object.fromEntries(Object.keys(stats[0].opens[0].timing).map(stage => [
        stage, metrics(stats.map(row => row.opens[0].timing[stage]).filter(Number.isFinite).map(us => us / 1000)),
      ])),
    });
  }
  console.log(JSON.stringify({ flutter, device: { cpu: cpus()[0]?.model, memory: totalmem(), release: release() },
    artifacts: Object.fromEntries(Object.entries(paths).map(([variant, path]) => [variant, artifactDigests(path)])),
    profile: 'fresh-process, warmed filesystem, local pinned file; open to viewer post-frame callback',
    summary, observations }, null, 2));
} else {
  const report = await observe(binary);
  console.log(JSON.stringify({ ...report, flutter, artifacts: artifactDigests(binary) }, null, 2));
}

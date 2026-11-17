import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

const binary = resolve(process.env.RAYKIT_FLUTTER_LINUX ?? 'examples/flutter/build/linux/x64/profile/bundle/raykit_example');
const deadline = Number(process.env.RAYKIT_PROFILE_TIMEOUT_SECONDS ?? 720);
assert(Number.isFinite(deadline) && deadline > 0);
const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1024x768x24', binary], {
  detached: true,
  stdio: ['ignore', 'pipe', 'ignore'],
  env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1' },
});
const sections = new Map();
const lines = createInterface({ input: child.stdout });
const close = () => {
  if (child.pid) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
};
process.once('SIGTERM', close);
try {
  const report = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Flutter profile deadline elapsed')), deadline * 1000);
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); reject(new Error('Flutter profile exited with ' + code)); });
    lines.on('line', line => {
      const match = /^RAYKIT_ACCEPTANCE (\d+)\/(\d+) (.*)$/.exec(line);
      if (!match) return;
      const index = Number(match[1]);
      const count = Number(match[2]);
      if (count < 1 || count > 128 || index < 1 || index > count) return;
      sections.set(index, match[3]);
      if (sections.size !== count) return;
      clearTimeout(timer);
      try { done(JSON.parse(Array.from({ length: count }, (_, i) => sections.get(i + 1)).join(''))); }
      catch (error) { reject(error); }
    });
  });
  const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  report.artifacts = { runner: hash(binary), app: hash(resolve(binary, '../lib/libapp.so')) };
  report.flutter = JSON.parse(execFileSync('flutter', ['--version', '--machine'], { encoding: 'utf8' }));
  delete report.flutter.flutterRoot;
  console.log(JSON.stringify(report, null, 2));
  if (report.observations.error) process.exitCode = 1;
} finally {
  lines.close();
  close();
}

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeNotices } from './notices.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = join(root, 'artifacts');
const staging = mkdtempSync(join(tmpdir(), 'raykit-package-'));
const flutter = join(staging, 'raykit');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && command === npm });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

try {
  mkdirSync(artifacts, { recursive: true });
  run(npm, ['run', 'build:web']);
  run(npm, ['pack', '--ignore-scripts', '--pack-destination', artifacts, './packages/web', './packages/web-component']);
  mkdirSync(flutter);
  for (const name of ['lib', 'hook', 'pubspec.yaml']) {
    cpSync(join(root, 'packages/flutter', name), join(flutter, name), { recursive: true });
  }
  cpSync(join(root, 'README.md'), join(flutter, 'README.md'));
  const native = join(flutter, 'native');
  mkdirSync(native);
  for (const name of ['Cargo.toml', 'Cargo.lock', 'crates', 'fixtures/support.rs', 'fixtures/generate.rs', 'examples/measurements']) {
    const target = join(native, name);
    mkdirSync(join(target, '..'), { recursive: true });
    cpSync(join(root, name), target, { recursive: true });
  }
  writeNotices(join(flutter, 'notices'), 'raykit-ffi', ['aarch64-linux-android', 'aarch64-apple-ios', 'x86_64-unknown-linux-gnu']);
  run('tar', ['-czf', join(artifacts, 'raykit-flutter-0.1.0.tar.gz'), 'raykit'], staging);
} finally {
  // The staging directory was created exclusively for this package run.
  rmSync(staging, { force: true, recursive: true });
}

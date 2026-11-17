import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeNotices } from './notices.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const host = { linux: 'linux', darwin: 'macos', win32: 'windows' }[process.platform];
const arch = { x64: 'x64', arm64: 'arm64' }[process.arch];
if (!host || !arch) throw new Error('Unsupported desktop build host');
const app = join(root, 'examples/flutter');
const artifacts = join(root, 'artifacts');
const bundle = {
  linux: 'build/linux/' + arch + '/release/bundle',
  windows: 'build/windows/' + arch + '/runner/Release',
  macos: 'build/macos/Build/Products/Release/raykit_example.app',
}[host];
const name = 'raykit-desktop-0.1.0-' + host + '-' + arch;
const rustHost = execFileSync('rustc', ['-vV'], { cwd: root, encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1].trim();
if (!rustHost) throw new Error('Could not identify the Rust build target');

function run(binary, args, cwd) {
  const result = spawnSync(binary, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && binary.endsWith('.bat') });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(binary + ' failed');
}

run(process.platform === 'win32' ? 'flutter.bat' : 'flutter', ['build', host, '--release'], app);
mkdirSync(artifacts, { recursive: true });
const stage = mkdtempSync(join(tmpdir(), 'raykit-desktop-'));
try {
  const out = join(stage, name);
  mkdirSync(out);
  cpSync(join(app, bundle), host === 'macos' ? join(out, 'raykit_example.app') : out, { recursive: true, verbatimSymlinks: true });
  cpSync(join(root, 'LICENSE'), join(out, 'LICENSE'));
  writeNotices(join(out, 'notices'), 'raykit-ffi', rustHost);
  run('tar', ['-czf', join(artifacts, name + '.tar.gz'), name], stage);
} finally { rmSync(stage, { recursive: true, force: true }); }

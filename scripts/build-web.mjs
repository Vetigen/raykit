import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { writeNotices } from './notices.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const generated = 'packages/web/src/generated';
const baseline = process.argv.includes('--baseline');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' && command === npm });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run('cargo', ['build', '--locked', '--release', '-p', 'raykit-wasm', '--target', 'wasm32-unknown-unknown', ...(baseline ? ['--no-default-features'] : [])]);
mkdirSync(new URL(`../${generated}/`, import.meta.url), { recursive: true });
run('wasm-bindgen', ['--target', 'web', '--out-dir', generated, 'target/wasm32-unknown-unknown/release/raykit_wasm.wasm']);
run(npm, ['run', 'build', '-w', '@raykit/web']);
cpSync(new URL(`../${generated}/`, import.meta.url), new URL('../packages/web/dist/generated/', import.meta.url), { recursive: true });
writeNotices(fileURLToPath(new URL('../packages/web/dist/notices/', import.meta.url)), 'raykit-wasm', 'wasm32-unknown-unknown', baseline);
run(npm, ['run', 'build', '-w', '@raykit/web-component']);

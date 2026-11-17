import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeNotices } from './notices.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const generated = 'packages/web/src/generated';
const baseline = process.argv.includes('--baseline');
const simd = process.argv.includes('--simd');
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' && command === npm });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const flags = process.env.CARGO_ENCODED_RUSTFLAGS?.split('\x1f') ?? process.env.RUSTFLAGS?.trim().split(/\s+/) ?? [];
const cargo = resolve(process.env.CARGO_HOME ?? join(homedir(), '.cargo'));
const rust = { ...process.env, CARGO_ENCODED_RUSTFLAGS: [...flags.filter(Boolean),
  `--remap-path-prefix=${resolve(root)}=/raykit`, `--remap-path-prefix=${cargo}=/cargo`,
  ...(simd ? ['-C', 'target-feature=+simd128'] : [])].join('\x1f') };
run('cargo', ['build', '--locked', '--release', '-p', 'raykit-wasm', '--target', 'wasm32-unknown-unknown', ...(baseline ? ['--no-default-features'] : [])], rust);
mkdirSync(new URL(`../${generated}/`, import.meta.url), { recursive: true });
run('wasm-bindgen', ['--target', 'web', '--out-dir', generated, 'target/wasm32-unknown-unknown/release/raykit_wasm.wasm']);
run(npm, ['run', 'build', '-w', '@raykit/web']);
cpSync(new URL(`../${generated}/`, import.meta.url), new URL('../packages/web/dist/generated/', import.meta.url), { recursive: true });
writeNotices(fileURLToPath(new URL('../packages/web/dist/notices/', import.meta.url)), 'raykit-wasm', 'wasm32-unknown-unknown', baseline);
run(npm, ['run', 'build', '-w', '@raykit/web-component']);

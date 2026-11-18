import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeNotices } from './notices.mjs';
import { rustVersion } from './release-lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const generated = 'packages/web/src/generated';
const baseline = process.argv.includes('--baseline');
const simd = process.argv.includes('--simd');
const eager = process.argv.includes('--eager');
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' && command === npm });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const manifest = readFileSync(join(root, 'crates/raykit-wasm/Cargo.toml'), 'utf8');
const bindgen = /^wasm-bindgen = "=(.*)"$/m.exec(manifest)?.[1];
const tool = spawnSync('wasm-bindgen', ['--version'], { cwd: root, encoding: 'utf8' });
if (!bindgen || tool.status !== 0 || tool.stdout.trim() !== 'wasm-bindgen ' + bindgen) {
  throw new Error(`Install the workspace WASM binding tool with cargo +${rustVersion} install wasm-bindgen-cli --locked --version ${bindgen}`);
}
const flags = process.env.CARGO_ENCODED_RUSTFLAGS?.split('\x1f') ?? process.env.RUSTFLAGS?.trim().split(/\s+/) ?? [];
const cargo = resolve(process.env.CARGO_HOME ?? join(homedir(), '.cargo'));
const version = createHash('sha256');
version.update(readFileSync(join(root, 'Cargo.lock')));
for (const crate of ['raykit-core', 'raykit-vet', 'raykit-protocol', 'raykit-wasm']) {
  const dir = join(root, 'crates', crate);
  version.update(readFileSync(join(dir, 'Cargo.toml')));
  for (const path of readdirSync(join(dir, 'src'), { recursive: true }).sort()) {
    if (path.endsWith('.rs')) version.update(readFileSync(join(dir, 'src', path)));
  }
}
const rust = { ...process.env, RAYKIT_ENGINE_VERSION: version.digest('hex'),
  CARGO_ENCODED_RUSTFLAGS: [...flags.filter(Boolean),
  `--remap-path-prefix=${resolve(root)}=/raykit`, `--remap-path-prefix=${cargo}=/cargo`,
  ...(simd ? ['-C', 'target-feature=+simd128'] : [])].join('\x1f') };
mkdirSync(new URL(`../${generated}/`, import.meta.url), { recursive: true });
const metadata = spawnSync('cargo', ['metadata', '--locked', '--no-deps', '--format-version=1'], { cwd: root, encoding: 'utf8' });
if (metadata.status !== 0) throw new Error(metadata.stderr || 'Cannot locate Rust target directory');
const wasm = join(JSON.parse(metadata.stdout).target_directory, 'wasm32-unknown-unknown/release/raykit_wasm.wasm');
function build(directory, advanced) {
  run('cargo', ['build', '--locked', '--release', '-p', 'raykit-wasm', '--target', 'wasm32-unknown-unknown',
    ...(!advanced ? ['--no-default-features'] : [])], rust);
  run('wasm-bindgen', ['--target', 'web', '--out-dir', directory, wasm]);
}
build(generated, eager && !baseline);
if (!baseline && !eager) build(generated + '/advanced', true);
else {
  // The import remains resolvable in hosts that deliberately ship one engine.
  const advanced = join(root, generated, 'advanced');
  mkdirSync(advanced, { recursive: true });
  for (const directory of [advanced, join(root, 'packages/web/dist/generated/advanced')]) {
    for (const filename of ['raykit_wasm_bg.wasm', 'raykit_wasm_bg.wasm.d.ts']) rmSync(join(directory, filename), { force: true });
  }
  for (const suffix of ['js', 'd.ts']) writeFileSync(join(advanced, 'raykit_wasm.' + suffix),
    "export { default } from '../raykit_wasm.js';\nexport * from '../raykit_wasm.js';\n");
}
run(npm, ['run', 'build', '-w', '@vetigen/raykit-web']);
cpSync(new URL(`../${generated}/`, import.meta.url), new URL('../packages/web/dist/generated/', import.meta.url), { recursive: true });
writeNotices(fileURLToPath(new URL('../packages/web/dist/notices/', import.meta.url)), 'raykit-wasm', 'wasm32-unknown-unknown', baseline);
run(npm, ['run', 'build', '-w', '@vetigen/raykit-web-component']);
for (const name of ['web', 'web-component']) cpSync(join(root, 'LICENSE'), join(root, 'packages', name, 'dist/LICENSE'));

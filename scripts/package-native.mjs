import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeNotices } from './notices.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = join(root, 'artifacts');
const staging = mkdtempSync(join(tmpdir(), 'raykit-native-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const flags = process.env.CARGO_ENCODED_RUSTFLAGS?.split('\x1f') ?? process.env.RUSTFLAGS?.trim().split(/\s+/) ?? [];
const cargo = resolve(process.env.CARGO_HOME ?? join(homedir(), '.cargo'));
const rust = { ...process.env, CARGO_ENCODED_RUSTFLAGS: [...flags.filter(Boolean),
  '--remap-path-prefix=' + resolve(root) + '=/raykit', '--remap-path-prefix=' + cargo + '=/cargo'].join('\x1f') };

function run(command, args, cwd = root, capture = false) {
  const result = spawnSync(command, args, {
    cwd, env: rust, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    shell: process.platform === 'win32' && command === npm,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + ' exited with ' + result.status);
  return result.stdout;
}

const version = '0.1.0';
try {
  mkdirSync(artifacts, { recursive: true });
  const target = run('rustc', ['-vV'], root, true).match(/^host: (.+)$/m)[1].trim();
  const { target_directory } = JSON.parse(run('cargo', ['metadata', '--locked', '--no-deps', '--format-version=1'], root, true));
  run('cargo', ['build', '--locked', '--release', '--target', target, '-p', 'raykit-cli', '-p', 'raykit-node', '-p', 'raykit-ffi']);
  const output = join(target_directory, target, 'release');
  const library = name => process.platform === 'win32' ? name + '.dll'
    : 'lib' + name + (process.platform === 'darwin' ? '.dylib' : '.so');
  const binary = process.platform === 'win32' ? 'raykit.exe' : 'raykit';

  const cli = 'raykit-' + version + '-' + target;
  mkdirSync(join(staging, cli));
  cpSync(join(output, binary), join(staging, cli, binary));
  cpSync(join(root, 'LICENSE'), join(staging, cli, 'LICENSE'));
  if (process.platform !== 'win32') chmodSync(join(staging, cli, binary), 0o755);
  writeNotices(join(staging, cli, 'notices'), 'raykit-cli', target);
  run('tar', ['-czf', join(artifacts, cli + '.tar.gz'), cli], staging);

  const node = join(staging, 'node');
  cpSync(join(root, 'packages/node'), node, { recursive: true });
  mkdirSync(join(node, 'native'));
  cpSync(join(root, 'LICENSE'), join(node, 'LICENSE'));
  cpSync(join(output, library('raykit_node')), join(node, 'native/raykit.node'));
  writeNotices(join(node, 'notices'), 'raykit-node', target);
  run(npm, ['pack', '--ignore-scripts', '--pack-destination', artifacts], node);

  const python = join(staging, 'python');
  cpSync(join(root, 'packages/python'), python, { recursive: true });
  mkdirSync(join(python, 'raykit/native'));
  cpSync(join(root, 'LICENSE'), join(python, 'LICENSE'));
  cpSync(join(output, library('raykit_ffi')), join(python, 'raykit/native', library('raykit_ffi')));
  writeNotices(join(python, 'raykit/notices'), 'raykit-ffi', target);
  run('uv', ['build', '--wheel', '--out-dir', artifacts], python);
} finally {
  rmSync(staging, { force: true, recursive: true });
}

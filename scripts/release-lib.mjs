import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const artifacts = resolve(process.env.RAYKIT_ARTIFACTS ?? join(root, 'artifacts'));
export const releaseTargets = JSON.parse(readFileSync(join(root, 'scripts/release-targets.json'), 'utf8'));
const workspacePackage = readFileSync(join(root, 'Cargo.toml'), 'utf8').split(/\[workspace\.package\]/)[1].split('\n[')[0];
export const version = /^version = "([0-9]+\.[0-9]+\.[0-9]+)"$/m.exec(workspacePackage)?.[1];
export const rustVersion = /^rust-version = "(.*)"$/m.exec(workspacePackage)?.[1];
if (!version || !rustVersion) throw new Error('Missing stable release version or Rust version in Cargo.toml');

export const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
export const flutter = process.platform === 'win32' ? 'flutter.bat' : 'flutter';
export const python = process.env.RAYKIT_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
export const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
export const npmPackageName = name => `@vetigen/raykit-${name}`;
export const npmArchive = name => `${npmPackageName(name).slice(1).replace('/', '-')}-${version}.tgz`;
export const nodeArchive = npmArchive('node');
export const flutterArchive = `raykit-flutter-${version}.tar.gz`;
export const pythonSdist = `raykit_dicom-${version}.tar.gz`;
export const cliArchive = target => `raykit-${version}-${target}.tar.gz`;
export const cArchive = target => `raykit-c-sdk-${version}-${target}.tar.gz`;
export const desktopArchive = target => `raykit-desktop-${version}-${target}.tar.gz`;
export const addonArchive = target => npmArchive(target.nodePackage);
export const wheelArchive = target => `raykit_dicom-${version}-py3-none-${target.wheel}.whl`;

export function nativeTarget() {
  const host = /^host: (.*)$/m.exec(execFileSync('rustc', ['-vV'], { cwd: root, encoding: 'utf8' }))?.[1].trim();
  const target = releaseTargets.targets.find(t => t.rust === host && t.os === process.platform && t.arch === process.arch);
  if (!target) throw new Error(`Unsupported native build host ${host}/${process.platform}/${process.arch}`);
  return target;
}

export function library(name) {
  if (process.platform === 'win32') return `${name}.dll`;
  return `lib${name}.${process.platform === 'darwin' ? 'dylib' : 'so'}`;
}

export function run(command, args, { cwd = root, env = process.env, capture = false } = {}) {
  if (process.platform === 'win32' && command === npm) {
    const cli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    return run(process.execPath, [cli, ...args], { cwd, env, capture });
  }
  if (process.platform === 'win32' && command === flutter) {
    // A batch file needs cmd.exe. Arguments are fixed tool options and generated paths.
    if (args.some(arg => /["%\r\n]/.test(arg))) throw new Error('Invalid Flutter command argument');
    command = [command, ...args.map(arg => `"${arg}"`)].join(' ');
    args = [];
  }
  const result = spawnSync(command, args, {
    cwd, env, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    shell: process.platform === 'win32' && command.startsWith(flutter + ' '),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}`);
  return result.stdout;
}

export function requireFresh(directory, names) {
  mkdirSync(directory, { recursive: true });
  for (const name of names) {
    if (existsSync(join(directory, name))) throw new Error(`Existing output ${name}. Select an empty RAYKIT_ARTIFACTS directory.`);
  }
}

export function stageRust(destination) {
  mkdirSync(destination, { recursive: true });
  for (const name of ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'LICENSE', 'README.md', 'crates']) {
    cpSync(join(root, name), join(destination, name), {
      recursive: true, filter: source => !/(?:^|[/\\])(?:\.git|target)(?:$|[/\\])/.test(source.slice(root.length)),
    });
  }
}

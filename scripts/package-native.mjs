import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeNotices } from './notices.mjs';
import {
  addonArchive, artifacts, cArchive, cliArchive, library, nativeTarget, npm, python,
  requireFresh, root, run, rustVersion, version, wheelArchive,
} from './release-lib.mjs';

const target = nativeTarget();
if (process.env.RAYKIT_EXPECT_TARGET && process.env.RAYKIT_EXPECT_TARGET !== target.rust) {
  throw new Error('Runner toolchain does not match the release target');
}
requireFresh(artifacts, [cliArchive(target.rust), cArchive(target.rust), addonArchive(target), wheelArchive(target)]);
const staging = mkdtempSync(join(tmpdir(), 'raykit-native-'));
const binary = target.os === 'win32' ? 'raykit.exe' : 'raykit';
const ffi = library('raykit_ffi');
const addon = library('raykit_node');
const flags = process.env.CARGO_ENCODED_RUSTFLAGS?.split('\x1f') ?? process.env.RUSTFLAGS?.trim().split(/\s+/) ?? [];
const cargoHome = resolve(process.env.CARGO_HOME ?? join(homedir(), '.cargo'));
const cargoEnv = {
  ...process.env,
  CARGO_ENCODED_RUSTFLAGS: [...flags.filter(Boolean), '--remap-path-prefix=' + resolve(root) + '=/raykit',
    '--remap-path-prefix=' + cargoHome + '=/cargo'].join('\x1f'),
  ...(target.os === 'darwin' ? { MACOSX_DEPLOYMENT_TARGET: '11.0' } : {}),
};
const rustBuild = ['build', '--locked', '--release', '--target', target.rust, '-p', 'raykit-cli', '-p', 'raykit-node', '-p', 'raykit-ffi'];

function archive(name, crate, assemble) {
  const folder = name.replace(/\.tar\.gz$/, '');
  const directory = join(staging, folder);
  mkdirSync(directory);
  assemble(directory);
  cpSync(join(root, 'LICENSE'), join(directory, 'LICENSE'));
  writeNotices(join(directory, 'notices'), crate, target.rust);
  run('tar', ['-czf', join(artifacts, name), folder], { cwd: staging });
}

try {
  let output;
  const pythonSource = join(staging, 'python');
  cpSync(join(root, 'packages/python'), pythonSource, { recursive: true });
  cpSync(join(root, 'LICENSE'), join(pythonSource, 'LICENSE'));
  const pythonNative = join(pythonSource, 'raykit_dicom/native');
  mkdirSync(pythonNative);
  writeNotices(join(pythonSource, 'raykit_dicom/notices'), 'raykit-ffi', target.rust);

  if (target.manylinux) {
    output = join(staging, 'built');
    mkdirSync(output);
    run('docker', ['run', '--rm', '--user', process.getuid() + ':' + process.getgid(),
      '--mount', 'type=bind,source=' + root + ',target=/source,readonly',
      '--mount', 'type=bind,source=' + staging + ',target=/out',
      '--env', 'RAYKIT_RUST=' + rustVersion, '--env', 'RAYKIT_TARGET=' + target.rust,
      '--env', 'RAYKIT_WHEEL_PLATFORM=' + target.wheel, '--env', 'CARGO_BUILD_JOBS=' + (process.env.CARGO_BUILD_JOBS ?? '4'),
      target.manylinux, 'bash', '/source/scripts/manylinux.sh']);
    cpSync(join(output, wheelArchive(target)), join(artifacts, wheelArchive(target)));
  } else {
    const { target_directory } = JSON.parse(run('cargo', ['metadata', '--locked', '--no-deps', '--format-version=1'], { capture: true }));
    run('cargo', rustBuild, { env: cargoEnv });
    output = join(target_directory, target.rust, 'release');
    cpSync(join(output, ffi), join(pythonNative, ffi));
    run(python, ['-m', 'build', '--wheel', '--outdir', artifacts], { cwd: pythonSource, env: cargoEnv });
  }

  archive(cliArchive(target.rust), 'raykit-cli', directory => {
    cpSync(join(output, binary), join(directory, binary));
    if (target.os !== 'win32') chmodSync(join(directory, binary), 0o755);
  });
  archive(cArchive(target.rust), 'raykit-ffi', directory => {
    mkdirSync(join(directory, 'lib'));
    cpSync(join(root, 'crates/raykit-ffi/include'), join(directory, 'include'), { recursive: true });
    const linkerFiles = target.os === 'win32' ? ['raykit_ffi.dll.lib', 'raykit_ffi.lib'] : ['libraykit_ffi.a'];
    for (const file of [ffi, ...linkerFiles]) cpSync(join(output, file), join(directory, 'lib', file));
  });

  const node = join(staging, 'node-addon');
  mkdirSync(node);
  cpSync(join(root, 'LICENSE'), join(node, 'LICENSE'));
  cpSync(join(output, addon), join(node, 'raykit.node'));
  writeNotices(join(node, 'notices'), 'raykit-node', target.rust);
  writeFileSync(join(node, 'package.json'), JSON.stringify({
    name: '@raykit/' + target.nodePackage, version,
    description: 'RayKit native Node-API addon for ' + target.rust,
    license: 'Apache-2.0', repository: { type: 'git', url: 'git+https://github.com/Vetigen/raykit.git' },
    publishConfig: { access: 'public' }, engines: { node: '>=22.14.0' },
    os: [target.os], cpu: [target.arch], ...(target.manylinux ? { libc: ['glibc'] } : {}),
    main: './raykit.node', files: ['raykit.node', 'LICENSE', 'notices'],
  }, null, 2) + '\n');
  run(npm, ['pack', '--ignore-scripts', '--pack-destination', artifacts], { cwd: node });
} finally {
  rmSync(staging, { force: true, recursive: true });
}

import 'dart:io';

import 'package:hooks/hooks.dart';
import 'package:logging/logging.dart';
import 'package:native_toolchain_rust/native_toolchain_rust.dart';

void main(List<String> args) async {
  await build(args, (input, output) async {
    final bundled = File.fromUri(
      input.packageRoot.resolve('native/crates/raykit-ffi/Cargo.toml'),
    ).existsSync();
    final workspace = input.packageRoot.resolve(bundled ? 'native/' : '../../');
    final env = Platform.environment;
    final home = env[Platform.isWindows ? 'USERPROFILE' : 'HOME'];
    final cargo =
        env['CARGO_HOME'] ??
        (home == null ? null : '$home${Platform.pathSeparator}.cargo');
    final flags =
        env['CARGO_ENCODED_RUSTFLAGS']?.split('\x1f') ??
        env['RUSTFLAGS']?.trim().split(RegExp(r'\s+')) ??
        const <String>[];
    final rustFlags = [
      ...flags.where((flag) => flag.isNotEmpty),
      '--remap-path-prefix=${workspace.toFilePath()}=/raykit/',
      if (cargo != null)
        '--remap-path-prefix=${Directory(cargo).absolute.path}=/cargo',
    ].join('\x1f');
    await RustBuilder(
      assetName: 'src/native.dart',
      cratePath: bundled
          ? 'native/crates/raykit-ffi'
          : '../../crates/raykit-ffi',
      extraCargoBuildArgs: ['--locked'],
      extraCargoEnvironmentVariables: {'CARGO_ENCODED_RUSTFLAGS': rustFlags},
    ).run(
      input: input,
      output: output,
      logger: Logger.detached('RayKit')..level = Level.WARNING,
    );
  });
}

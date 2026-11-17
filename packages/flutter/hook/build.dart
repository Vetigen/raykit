import 'dart:io';

import 'package:hooks/hooks.dart';
import 'package:logging/logging.dart';
import 'package:native_toolchain_rust/native_toolchain_rust.dart';

void main(List<String> args) async {
  await build(args, (input, output) async {
    final bundled = File.fromUri(
      input.packageRoot.resolve('native/crates/raykit-ffi/Cargo.toml'),
    ).existsSync();
    await RustBuilder(
      assetName: 'src/native.dart',
      cratePath: bundled
          ? 'native/crates/raykit-ffi'
          : '../../crates/raykit-ffi',
      extraCargoBuildArgs: ['--locked'],
    ).run(
      input: input,
      output: output,
      logger: Logger.detached('RayKit')..level = Level.WARNING,
    );
  });
}

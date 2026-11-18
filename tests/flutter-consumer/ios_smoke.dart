import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:raykit/raykit.dart';

Future<void> writeResult(Json result) async {
  final output = File(
    Platform.environment['RAYKIT_IOS_SMOKE_OUTPUT'] ??
        '${Directory.systemTemp.path}/raykit-ios-smoke.json',
  );
  final temporary = File('${output.path}.tmp');
  await temporary.writeAsString(jsonEncode(result), flush: true);
  await temporary.rename(output.path);
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final reference =
      jsonDecode(
            await rootBundle.loadString(
              'assets/raykit/comparison-reference.json',
            ),
          )
          as Json;
  final bytes = await rootBundle.load('assets/raykit/comparison-ct.dcm');
  final controller = RayKitViewerController();
  final index = reference['frame'] as int;
  final [x as int, y as int] = reference['pixel'] as List;
  var reported = false;
  Future<void> verify(RayKitPresentedFrame frame) async {
    if (reported) return;
    reported = true;
    final session = controller.session!;
    try {
      final sample = await session.sampleAt(index, x, y);
      final measurement = await session.measure(index, {
        'id': 'simulator-distance',
        'method': 'raykit:length',
        'version': 1,
        'points': [
          {'x': x, 'y': y},
          {'x': x + 10, 'y': y},
        ],
      });
      await writeResult({
        'presented': frame.source,
        'renderer': frame.renderer,
        'sample': sample,
        'measurement': (await session.verifyMeasurement(measurement))['values'],
      });
    } finally {
      await session.close();
    }
  }

  runApp(
    MaterialApp(
      home: Scaffold(
        body: RayKitViewer(
          source: RayKitSource.bytes(
            bytes.buffer.asUint8List(bytes.offsetInBytes, bytes.lengthInBytes),
          ),
          options: RayKitOpenOptions(
            expectedSha256: reference['sha256'] as String,
          ),
          initialFrame: index,
          controller: controller,
          onPresented: (frame) => unawaited(
            verify(frame).catchError(
              (Object error) => writeResult({'error': error.toString()}),
            ),
          ),
        ),
      ),
    ),
  );
}

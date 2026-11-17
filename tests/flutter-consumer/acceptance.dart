import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:raykit/raykit.dart';

Future<void> untilPresented(WidgetTester tester, bool Function() ready) async {
  final deadline = Stopwatch()..start();
  while (!ready() && deadline.elapsed < const Duration(seconds: 15)) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 10)),
    );
    await tester.pump();
  }
  expect(
    ready(),
    isTrue,
    reason: 'The viewer did not reach the expected state',
  );
}

Future<void> verifyPresentedCt(WidgetTester tester) async {
  final content = (await tester.runAsync(
    () => rootBundle.load('assets/raykit/comparison-ct.dcm'),
  ))!;
  final reference =
      jsonDecode(
            (await tester.runAsync(
              () => rootBundle.loadString(
                'assets/raykit/comparison-reference.json',
              ),
            ))!,
          )
          as Json;
  final controller = RayKitViewerController();
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: RayKitViewer(
          source: RayKitSource.bytes(
            content.buffer.asUint8List(
              content.offsetInBytes,
              content.lengthInBytes,
            ),
          ),
          options: RayKitOpenOptions(
            expectedSha256: reference['sha256'] as String,
          ),
          initialFrame: reference['frame'] as int,
          controller: controller,
        ),
      ),
    ),
  );
  await untilPresented(tester, () => controller.presented != null);
  expect(controller.presented!.source['content_sha256'], reference['sha256']);
  expect(controller.presented!.source['frame'], reference['frame']);
  final [x as int, y as int] = reference['pixel'] as List;
  final sample = (await tester.runAsync(
    () => controller.samplePresented(x, y),
  ))!;
  expect(sample['stored'], reference['stored']);
  expect(sample['modality'], reference['modality']);
  await tester.pumpWidget(const SizedBox());
}

Future<void> verifyInstalledRayKit() async {
  final reference =
      jsonDecode(
            await rootBundle.loadString(
              'assets/raykit/comparison-reference.json',
            ),
          )
          as Json;
  final bytes = await rootBundle.load('assets/raykit/comparison-ct.dcm');
  final source = bytes.buffer.asUint8List(
    bytes.offsetInBytes,
    bytes.lengthInBytes,
  );
  final index = reference['frame'] as int;
  final [x as int, y as int] = reference['pixel'] as List;
  final session = await RayKitSession.open(
    RayKitSource.bytes(source),
    options: RayKitOpenOptions(expectedSha256: reference['sha256'] as String),
  );
  try {
    final sample = await session.sampleAt(index, x, y);
    expect(
      sample['source'],
      containsPair('content_sha256', reference['sha256']),
    );
    expect(sample['sample'], containsPair('stored', reference['stored']));
    expect(sample['sample'], containsPair('modality', reference['modality']));
    expect(sample['patient'], reference['patient']);
    expect(sample['modality_unit'], reference['unit']);
    for (var window = 0; window < 2; window++) {
      final view = await session.render(index, {
        'voi': {'kind': 'window', 'index': window},
      });
      expect(
        sha256.convert(view).toString(),
        (reference['rgba_sha256'] as List)[window],
      );
    }
    final record = await session.measure(index, {
      'id': 'comparison-ruler',
      'method': 'raykit:length',
      'version': 1,
      'points': [
        {'x': x, 'y': y},
        {'x': x + 10, 'y': y},
      ],
    });
    expect(record['values'], [
      {'name': 'length', 'value': 7, 'unit': 'millimeter'},
    ]);
    expect(await session.reopenMeasurement(record), record);
    await expectLater(
      session.verifyMeasurement({
        ...record,
        'values': [
          {'name': 'length', 'value': 8, 'unit': 'millimeter'},
        ],
      }),
      throwsA(
        isA<RayKitException>().having(
          (error) => error.code,
          'code',
          'integrity',
        ),
      ),
    );
    final evidence = jsonEncode({
      'sample': sample,
      'rgba_sha256': reference['rgba_sha256'],
      'length_mm': 7,
      'tamper_rejected': true,
    });
    final report = Platform.environment['RAYKIT_FLUTTER_EVIDENCE'];
    if (report != null) await File(report).writeAsString(evidence);
    debugPrint(evidence);
  } finally {
    await session.close();
  }
}

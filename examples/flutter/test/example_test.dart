import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:raykit/raykit.dart';
import 'package:raykit_example/main.dart' as example;

void main() {
  testWidgets(
    'example opens a bundled DICOM and releases the native source between openings',
    (tester) async {
      await tester.pumpWidget(const MaterialApp(home: example.ExampleViewer()));
      await tester.tap(find.text('Synthetic radiograph'));
      await tester.pump();
      await until(
        tester,
        () => find.textContaining('Original · 64 × 48').evaluate().isNotEmpty,
      );
      final controller = tester
          .widget<RayKitViewer>(find.byType(RayKitViewer))
          .controller!;
      final first = controller.session!;
      expect(
        (await tester.runAsync(() => first.sample(0, 10, 10)))?['stored'],
        -1540,
      );
      expect(first.inspection.capabilities['frame_access'], true);
      final record = await tester.runAsync(
        () => first.measure(0, {
          'id': 'packaged-vhs',
          'method': 'raykit:canine-vhs',
          'version': 1,
          'parameters': {'projection': 'lateral_thorax'},
          'points': [
            for (final (x, y) in [
              (0, 2),
              (10, 2),
              (5, 0),
              (5, 8),
              (0, 20),
              (4, 20),
              (8, 20),
              (12, 20),
            ])
              {'x': x, 'y': y},
          ],
        }),
      );
      await tester.tap(find.byTooltip('Close image'));
      await tester.pump();
      expect(find.byType(RayKitViewer), findsNothing);
      final rejected = await tester.runAsync(() async {
        try {
          await first.sample(0, 10, 10);
          return false;
        } on RayKitException catch (error) {
          return error.code == 'closed';
        }
      });
      expect(rejected, isTrue);
      await tester.tap(find.text('Synthetic radiograph'));
      await tester.pump();
      await until(
        tester,
        () => find.textContaining('Original · 64 × 48').evaluate().isNotEmpty,
      );
      final restored = await tester.runAsync(
        () => controller.restoreMeasurement(
          jsonDecode(jsonEncode(record)) as Json,
        ),
      );
      expect(
        (restored!['values'] as List).map((value) => (value as Json)['value']),
        [2.5, 1.0, 3.5],
      );
    },
  );
}

Future<void> until(WidgetTester tester, bool Function() done) async {
  final timeout = Stopwatch()..start();
  while (!done() && timeout.elapsedMilliseconds < 5000) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 10)),
    );
    await tester.pump();
  }
  expect(done(), isTrue);
}

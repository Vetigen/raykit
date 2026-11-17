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
  testWidgets(
    'installed example draws shaders, indexed cine and a large CT volume',
    (tester) async {
      await tester.pumpWidget(const MaterialApp(home: example.ExampleViewer()));
      await tester.tap(find.text('16-bit shader'));
      await tester.tap(find.text('Synthetic radiograph'));
      await tester.pump();
      RayKitViewerController controller() =>
          tester.widget<RayKitViewer>(find.byType(RayKitViewer)).controller!;
      await until(tester, () => controller().presented != null);
      expect(controller().presented!.renderer, 'shader');
      final stats = controller().displayStats;
      final changing = controller().setRenderOptions({
        'window': {'center': -3180, 'width': 2, 'function': 'linear_exact'},
      });
      await until(tester, () => controller().presented!.render.isNotEmpty);
      await changing;
      expect(
        controller().displayStats['image_upload_bytes'],
        stats['image_upload_bytes'],
      );
      await tester.tap(find.text('Indexed ultrasound'));
      await tester.pump();
      await until(
        tester,
        () =>
            controller().session?.inspection.data['verification'] ==
                'pinned_frame_index' &&
            controller().presented != null,
      );
      expect(controller().presented!.renderer, 'cpu');
      final moving = controller().seek(349);
      await until(tester, () => controller().presented?.source['frame'] == 349);
      await moving;
      expect(
        (await tester.runAsync(
          () => controller().samplePresented(0, 0),
        ))!['values'],
        [189, 87, 75],
      );
      await tester.tap(find.text('300-slice CT'));
      await tester.pump();
      await until(tester, () => find.text('Volume').evaluate().isNotEmpty);
      await tester.tap(find.text('Volume'));
      await tester.pump();
      await until(
        tester,
        () => find.textContaining('300 source slices').evaluate().isNotEmpty,
      );
      final volumeSource = controller().session!;
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      await until(tester, () => volumeSource.isClosed);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await until(
        tester,
        () => find
            .text('Open the volume again to restore its session')
            .evaluate()
            .isNotEmpty,
      );
      expect(
        find.descendant(
          of: find.byType(RayKitVolumeView),
          matching: find.byType(RawImage),
        ),
        findsNothing,
      );
      final navigator = tester.state<NavigatorState>(find.byType(Navigator));
      navigator.pop();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await until(
        tester,
        () =>
            controller().session != volumeSource &&
            controller().presented != null,
      );
      await tester.tap(find.byTooltip('Close image'));
      await tester.pump();
      expect(find.byType(RayKitViewer), findsNothing);
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

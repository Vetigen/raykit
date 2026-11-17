import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:raykit/raykit.dart';
import 'package:raykit_example/main.dart' as example;

void main() {
  testWidgets(
    'example opens a bundled DICOM and releases the native source between openings',
    (tester) async {
      await tester.pumpWidget(const MaterialApp(home: example.ExampleViewer()));
      await chooseFixture(tester, 'Synthetic radiograph');
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
      await chooseFixture(tester, 'Synthetic radiograph');
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
      await chooseFixture(tester, 'Synthetic radiograph');
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
      await chooseFixture(tester, 'Indexed ultrasound');
      await until(
        tester,
        () =>
            controller().session?.inspection.data['verification'] ==
                'pinned_frame_index' &&
            controller().presented != null,
      );
      expect(controller().presented!.renderer, 'cpu');
      final moving = controller().seek(349);
      await until(
        tester,
        () => controller().presented?.source['frame'] == 349,
        reason: () =>
            'Indexed seek ended at ${controller().presented?.source["frame"]} '
            'with view ${controller().presented?.view} and counters ${controller().displayStats}. '
            'Image area ${tester.getSize(find.descendant(of: find.byType(RayKitViewer), matching: find.byType(LayoutBuilder)).first)}.',
      );
      await moving;
      expect(
        (await tester.runAsync(
          () => controller().samplePresented(0, 0),
        ))!['values'],
        [189, 87, 75],
      );
      await chooseFixture(tester, '300-slice CT');
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

  testWidgets(
    'a local study keeps separate source identities in the comparison',
    (tester) async {
      final folder = Directory.systemTemp.createTempSync('raykit-study-test-');
      try {
        await tester.runAsync(() async {
          for (final file in ['comparison-mr-t1.dcm', 'comparison-mr-t2.dcm']) {
            final asset = await rootBundle.load('assets/raykit/$file');
            File('${folder.path}/$file').writeAsBytesSync(
              asset.buffer.asUint8List(
                asset.offsetInBytes,
                asset.lengthInBytes,
              ),
            );
          }
        });
        await tester.pumpWidget(
          MaterialApp(home: example.ExampleViewer(initialPath: folder.path)),
        );
        final viewer = find.byType(RayKitViewer);
        await until(
          tester,
          () =>
              viewer.evaluate().isNotEmpty &&
              tester.widget<RayKitViewer>(viewer).controller?.presented != null,
        );
        await tester.tap(find.text('Compare study series'));
        await tester.pumpAndSettle();
        expect(find.byType(SimpleDialogOption), findsOneWidget);
        await tester.tap(find.byType(SimpleDialogOption));
        await tester.pump();
        final compared = find.descendant(
          of: find.byType(RayKitComparison),
          matching: viewer,
        );
        await until(tester, () {
          final panels = tester.widgetList<RayKitViewer>(compared).toList();
          return panels.length == 2 &&
              panels.every((panel) => panel.controller?.presented != null);
        });
        final sources = tester
            .widgetList<RayKitViewer>(compared)
            .map((panel) => panel.controller!.presented!.source['instance_uid'])
            .toSet();
        expect(sources, {'2.25.1971', '2.25.1972'});
        expect(
          tester
              .widget<RayKitComparison>(find.byType(RayKitComparison))
              .registration,
          isNull,
        );
        await tester.pumpWidget(const SizedBox());
        await tester.pump();
      } finally {
        folder.deleteSync(recursive: true);
      }
    },
  );
}

Future<void> chooseFixture(WidgetTester tester, String fixture) async {
  await tester.tap(find.text('Synthetic cases'));
  await tester.pumpAndSettle();
  await tester.ensureVisible(find.text(fixture));
  await tester.tap(find.text(fixture));
  await tester.pump();
}

Future<void> until(
  WidgetTester tester,
  bool Function() done, {
  String Function()? reason,
}) async {
  final timeout = Stopwatch()..start();
  while (!done() && timeout.elapsedMilliseconds < 5000) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 10)),
    );
    await tester.pump();
  }
  expect(done(), isTrue, reason: done() ? null : reason?.call());
}

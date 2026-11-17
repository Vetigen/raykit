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
      final first = tester
          .widget<RayKitViewer>(find.byType(RayKitViewer))
          .controller!
          .session!;
      expect(
        (await tester.runAsync(() => first.sample(0, 10, 10)))?['stored'],
        -1540,
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

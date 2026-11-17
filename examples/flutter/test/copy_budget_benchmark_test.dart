import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:raykit/raykit.dart';

void main() {
  testWidgets('same viewer input and windowed seek on both package builds', (
    tester,
  ) async {
    const asset = 'large-enhanced-ct.dcm';
    final manifest =
        jsonDecode(File('assets/raykit/manifest.json').readAsStringSync())
            as Json;
    final expected = manifest[asset] as Json;
    final file = File('assets/raykit/$asset');
    final rss = ProcessInfo.currentRss;
    final viewer = RayKitViewerController();
    RayKitPresentedFrame? frame;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: RayKitViewer(
            source: RayKitSource.file(file),
            controller: viewer,
            options: RayKitOpenOptions(
              expectedSha256: expected['sha256'] as String,
              expectedSize: expected['bytes'] as int,
            ),
            onPresented: (event) => frame = event,
          ),
        ),
      ),
    );
    await until(tester, () => frame != null);
    debugPrint('Local file presented');
    final session = viewer.session!;
    final picker = find.byWidgetPredicate(
      (widget) =>
          widget is DropdownButton &&
          (widget.items?.any(
                (option) =>
                    option.child is Text &&
                    (option.child as Text).data == 'Window / level',
              ) ??
              false),
    );
    await tester.tap(picker);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Window / level').last);
    await tester.pumpAndSettle();
    final surface = find
        .descendant(
          of: find.byType(RayKitViewer),
          matching: find.byWidgetPredicate(
            (widget) =>
                widget is GestureDetector && widget.onScaleUpdate != null,
          ),
        )
        .first;
    final gesture = await tester.startGesture(tester.getCenter(surface));
    await gesture.moveBy(const Offset(35, 14));
    await tester.pump();
    await gesture.moveBy(const Offset(30, 14));
    await gesture.up();
    await until(tester, () => frame?.render['window'] != null);
    debugPrint('Window adjustment presented');
    final before = (await tester.runAsync(session.stats))!;
    final output = <int>[];
    final timings = <double>[];
    var previous = before['output_copy_bytes'] as int;
    for (final index in [37, 95, 151, 214, 280]) {
      final watch = Stopwatch()..start();
      final work = viewer.seek(index);
      await until(tester, () => frame?.source['frame'] == index);
      await work;
      timings.add(watch.elapsedMicroseconds / 1000);
      final stats = (await tester.runAsync(session.stats))!;
      final copied = stats['output_copy_bytes'] as int;
      output.add(copied - previous);
      previous = copied;
      expect(frame!.render['window'], isNotNull);
      expect(frame!.source['content_sha256'], expected['sha256']);
    }
    final peak = ProcessInfo.maxRss;
    await tester.pumpWidget(const SizedBox());
    final result = {
      'revision': const String.fromEnvironment('RAYKIT_REVISION'),
      'fixture_sha256': expected['sha256'],
      'os': Platform.operatingSystemVersion,
      'dart': Platform.version,
      'runtime': 'Flutter widget raster test',
      'initial_rss_bytes': rss,
      'process_max_rss_bytes': peak,
      'native_input_copy_bytes': before['native_input_copy_bytes'],
      'output_bytes_per_windowed_frame': output,
      'windowed_seek_ms': timings,
    };
    debugPrint('RAYKIT_COPY_BUDGET ${jsonEncode(result)}');
  });
}

Future<void> until(WidgetTester tester, bool Function() done) async {
  final watch = Stopwatch()..start();
  while (!done() && watch.elapsed < const Duration(seconds: 10)) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 8)),
    );
    await tester.pump();
  }
  expect(done(), isTrue);
}

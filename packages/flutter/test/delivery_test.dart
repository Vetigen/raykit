import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:raykit/raykit.dart';
import 'package:raykit/src/native.dart' as native;

File fixture(String name) => File('../../fixtures/generated/$name.dcm');

void main() {
  testWidgets(
    'one source serves four immutable original views and reopened measurements',
    (tester) async {
      final ref =
          jsonDecode(
                File(
                  '../../benchmarks/evidence/comparison-reference.json',
                ).readAsStringSync(),
              )
              as Json;
      final baseline = native.liveSessions();
      final source = RayKitSource.file(fixture('comparison-ct'));
      final session = (await tester.runAsync(
        () => RayKitSession.open(
          source,
          options: RayKitOpenOptions(
            expectedSha256: ref['sha256'] as String,
            revision: 'comparison-fixture',
          ),
        ),
      ))!;
      final attached = RayKitSource.attached(session);
      final controllers = List.generate(4, (_) => RayKitViewerController());
      Widget app(int start, int count) => MaterialApp(
        home: Scaffold(
          body: Row(
            children: [
              for (var i = start; i < count; i++)
                Expanded(
                  key: ValueKey(i),
                  child: RayKitViewer(
                    key: ValueKey(i),
                    source: attached,
                    controller: controllers[i],
                    showControls: false,
                    initialFrame: 150,
                    initialRender: {
                      'voi': {'kind': 'window', 'index': i % 2},
                    },
                  ),
                ),
            ],
          ),
        ),
      );
      await tester.pumpWidget(app(0, 1));
      await waitFor(
        tester,
        () => controllers[0].presented?.source['frame'] == 150,
      );
      await tester.pumpWidget(app(0, 4));
      await waitFor(
        tester,
        () => controllers.every(
          (controller) => controller.presented?.source['frame'] == 150,
        ),
      );
      expect(native.liveSessions(), baseline + 1);
      final stats = (await tester.runAsync(session.stats))!;
      expect((stats['session'] as Json)['decoded_frames'], 1);
      expect(
        (stats['session'] as Json)['source_read_bytes'],
        fixture('comparison-ct').lengthSync(),
      );
      final seen = await tester.runAsync(
        () async =>
            Future.wait(controllers.map((c) => c.samplePresented(256, 256))),
      );
      expect(
        seen!.every(
          (sample) => sample['stored'] == 474 && sample['modality'] == 448,
        ),
        true,
      );
      final snapshot = await tester.runAsync(
        () => session.sampleAt(150, 256, 256),
      );
      expect(snapshot!['modality_unit'], 'HU');
      expect(snapshot['patient'], [179.2, 204.8, 180.0]);
      expect(
        controllers.map((c) => (c.presented!.render['voi'] as Json)['index']),
        [0, 1, 0, 1],
      );
      final record = (await tester.runAsync(
        () => session.measure(150, {
          'id': 'comparison-ruler',
          'method': 'raykit:length',
          'version': 1,
          'points': [
            {'x': 256, 'y': 256},
            {'x': 266, 'y': 256},
          ],
        }),
      ))!;
      await session.close();
      await tester.pumpWidget(app(1, 4));
      await waitFor(
        tester,
        () =>
            controllers.first.session == null &&
            controllers.last.presented?.source['frame'] == 150,
      );
      expect(
        (await tester.runAsync(
          () => controllers.last.samplePresented(256, 256),
        ))?['modality'],
        448,
      );
      final sender = RayKitSharedView(
        controllers[2],
        'reader',
        (_) async => true,
      );
      final receiver = RayKitSharedView(
        controllers.last,
        'receiver',
        (event) async => event['origin'] == 'reader',
      );
      final event = sender.outgoing(controllers[2].presented!)!;
      expect(await receiver.apply({...event, 'revision': 'different'}), false);
      expect(await receiver.apply({...event, 'origin': 'denied'}), false);
      final changing = receiver.apply(event);
      await waitFor(
        tester,
        () =>
            controllers.last.presented?.render['voi'] != null &&
            (controllers.last.presented?.render['voi'] as Json)['index'] == 0,
      );
      expect(await changing, true);
      expect(await receiver.apply(event), false);
      sender.close();
      receiver.close();

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      await waitFor(tester, () => controllers.last.presented == null);
      expect(native.liveSessions(), baseline + 1);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await waitFor(
        tester,
        () => controllers.last.presented?.source['frame'] == 150,
      );
      expect(controllers.last.session, same(session));

      await tester.pumpWidget(const SizedBox());
      await waitFor(tester, () => native.liveSessions() == baseline);
      final reopened = (await tester.runAsync(
        () => RayKitSession.open(source),
      ))!;
      try {
        expect(
          await tester.runAsync(() => reopened.reopenMeasurement(record)),
          record,
        );
        expect(
          ((record['values'] as List).single as Json)['value'],
          closeTo(7, 1e-9),
        );
      } finally {
        await tester.runAsync(reopened.close);
      }
    },
  );

  testWidgets(
    'synthetic preview freezes a painted frame and verifies only its calibrated original',
    (tester) async {
      final controller = RayKitLiveController(
        maxLateness: const Duration(seconds: 15),
      );
      var stream = StreamController<RayKitLiveFrame>();
      final options =
          jsonDecode(
                File(
                  '../../fixtures/generated/manifest.json',
                ).readAsStringSync(),
              )
              as Json;
      final color = RayKitSource.file(fixture('us-rgb-planar'));
      final noGeometry = RayKitSource.file(fixture('us-gray-time'));
      const capture = (acquisition: 'synthetic-us', frame: '0');
      RayKitLiveFrame frame(int index, {RayKitCapture? identity}) {
        final bytes = Uint8List(8 * 6 * 4);
        for (var i = 0; i < bytes.length; i += 4) {
          bytes[i] = 12 + index;
          bytes[i + 1] = 34;
          bytes[i + 2] = 56;
          bytes[i + 3] = 255;
        }
        return RayKitLiveFrame(
          index,
          controller.now,
          8,
          6,
          bytes,
          capture: identity,
        );
      }

      controller.start(id: 'preview', revision: '1', frames: stream.stream);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: RayKitLiveView(controller: controller)),
        ),
      );
      stream.add(frame(0, identity: capture));
      await waitFor(tester, () => controller.presentedSequence == 0);
      expect(controller.freeze(), true);
      controller.disconnect();
      expect(controller.connection, RayKitLiveConnection.disconnected);
      expect(controller.lastImageAge, isNotNull);
      unawaited(stream.close());
      stream = StreamController<RayKitLiveFrame>();
      controller.start(id: 'preview', revision: '1', frames: stream.stream);
      stream.add(frame(0));
      stream.add(frame(2));
      await tester.pump();
      expect(controller.presentedSequence, 0);
      expect(controller.unseen, 1);
      expect(controller.skipped, 1);
      Future<void> bind(
        RayKitSource source,
        String name,
        String instance,
        RayKitCapture id,
      ) => controller.bindOriginal(
        (_, _) async => (
          capture: id,
          source: source,
          frame: 0,
          instanceUid: instance,
          sha256: (options['$name.dcm'] as Json)['sha256'] as String,
        ),
      );
      await tester.runAsync(
        () => expectLater(
          bind(color, 'us-rgb-planar', '2.25.840', (
            acquisition: 'synthetic-us',
            frame: 'other',
          )),
          throwsA(
            isA<RayKitException>().having((e) => e.code, 'code', 'integrity'),
          ),
        ),
      );
      await tester.runAsync(
        () => expectLater(
          bind(noGeometry, 'us-gray-time', '2.25.842', capture),
          throwsA(
            isA<RayKitException>().having((e) => e.code, 'code', 'geometry'),
          ),
        ),
      );
      await tester.runAsync(
        () => bind(color, 'us-rgb-planar', '2.25.840', capture),
      );
      await waitFor(
        tester,
        () => find.textContaining('Original · 8 × 6').evaluate().isNotEmpty,
      );
      unawaited(stream.close());
      await waitFor(
        tester,
        () => controller.connection == RayKitLiveConnection.ended,
      );
      controller.goLive();
      await waitFor(tester, () => controller.presentedSequence == 2);
      expect(controller.frozen, false);
      expect(controller.connection, RayKitLiveConnection.ended);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    },
  );
}

Future<void> waitFor(WidgetTester tester, bool Function() done) async {
  final elapsed = Stopwatch()..start();
  while (!done() && elapsed.elapsed < const Duration(seconds: 10)) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 8)),
    );
    await tester.pump();
  }
  expect(done(), true);
}

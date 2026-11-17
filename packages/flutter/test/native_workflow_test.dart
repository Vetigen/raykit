import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:raykit/raykit.dart';
import 'package:raykit/src/native.dart' as native;

RayKitSource fixture(String name) =>
    RayKitSource.file(File('../../fixtures/generated/$name.dcm'));

const measureRequest = {
  'id': 'test-length',
  'method': 'raykit:length',
  'version': 1,
  'points': [
    {'x': 0, 'y': 0},
    {'x': 6, 'y': 16},
  ],
};

void main() {
  test(
    'advanced DICOM profiles and enhanced CT use the same native core',
    () async {
      final manifest =
          jsonDecode(
                await File(
                  '../../fixtures/generated/manifest.json',
                ).readAsString(),
              )
              as Json;
      var verified = 0;
      for (final entry in manifest.entries) {
        if (!entry.key.startsWith('jpeg-') && !entry.key.startsWith('htj2k')) {
          continue;
        }
        final data = entry.value as Json;
        final expected = data['expected'] as Json;
        final session = await RayKitSession.open(
          fixture(entry.key.replaceFirst('.dcm', '')),
          options: RayKitOpenOptions(expectedSha256: data['sha256'] as String),
        );
        try {
          final frame = await session.readFrame(0);
          final stored = ByteData.sublistView(frame.pixels);
          for (final (i, value) in (expected['stored'] as List).indexed) {
            expect(
              (stored.getInt32(i * 4, Endian.little) - (value as int)).abs(),
              lessThanOrEqualTo(expected['tolerance'] as int),
            );
          }
        } finally {
          await session.close();
        }
        verified++;
      }
      expect(verified, 10);
      final session = await RayKitSession.open(fixture('enhanced-ct-oblique'));
      try {
        final snapshot = await session.volumeCandidates();
        expect((snapshot['candidates'] as List).length, 2);
        final metadata = await session.buildVolume(
          0,
          snapshot['revision'] as int,
        );
        expect(metadata['dimensions'], [8, 6, 3]);
        final segment = await session.segmentation(
          fixture('phantom-seg'),
          0,
          1,
        );
        expect(segment.mask[2 * 8 + 4], 1);
        expect(
          (await session.presentation(
            fixture('phantom-gsps'),
            0,
          ))['quarter_turns'],
          1,
        );
        final patient = [-8.86, 7.98, 15.8];
        expect(await session.sampleVolume(patient), 136.0);
        final reslice = await session.reslice({
          'center': patient,
          'orientation': {'kind': 'coronal'},
          'dimensions': [1, 1],
          'spacing_xy': [0.5, 0.5],
          'slab': {'kind': 'single'},
        });
        expect(
          ByteData.sublistView(reslice.pixels).getFloat32(0, Endian.little),
          136.0,
        );
      } finally {
        await session.close();
      }
    },
  );
  test(
    'native session preserves samples, calibration, windowing and exact source identity',
    () async {
      final baseline = native.liveSessions();
      final buffers = native.liveBuffers();
      final session = await RayKitSession.open(fixture('signed12'));
      try {
        expect(session.inspection.frames, 1);
        expect(native.liveSessions(), baseline + 1);
        final frame = await session.readFrame(0);
        expect(frame.encoding, 'mono_i32_le');
        expect(await session.sample(0, 10, 10), {
          'kind': 'monochrome',
          'stored': -1540,
          'modality': -3180.0,
          'padding': false,
        });
        final rendered = await session.render(0, {
          'window': {'width': 2, 'center': -3180, 'function': 'linear_exact'},
        });
        expect(rendered.sublist(2600, 2604), [128, 128, 128, 255]);
        final record = await session.measure(0, measureRequest);
        expect((record['values'] as List).single, {
          'name': 'length',
          'value': 5.0,
          'unit': 'millimeter',
        });
        expect(await session.reopenMeasurement(record), record);
        final sr = await session.importSr(fixture('distance-sr'));
        expect(
          (sr['values'] as List).single,
          (record['values'] as List).single,
        );
        final other = await RayKitSession.open(fixture('signed12-big-endian'));
        try {
          await expectLater(
            other.reopenMeasurement(record),
            throwsA(
              isA<RayKitException>().having((e) => e.code, 'code', 'integrity'),
            ),
          );
        } finally {
          await other.close();
        }
        expect(
          (await session.stats())['session'],
          containsPair('decoded_frames', 1),
        );
      } finally {
        await session.close();
      }
      expect(native.liveSessions(), baseline);
      expect(native.liveBuffers(), buffers);
    },
  );

  test(
    'racing seek, cancellation and close finish the native handle once',
    () async {
      final baseline = native.liveSessions();
      final buffers = native.liveBuffers();
      final session = await RayKitSession.open(fixture('cine-350'));
      for (final index in [0, 175, 349]) {
        expect((await session.readFrame(index)).index, index);
        final color = (await session.sample(index, 0, 0))['values'] as List;
        final reference = [
          32 + index % 192,
          64 + (index * 3) % 128,
          64 + (index * 7) % 128,
        ];
        for (var channel = 0; channel < 3; channel++) {
          expect(
            (color[channel] as int) - reference[channel],
            inInclusiveRange(-4, 4),
          );
        }
      }
      expect(
        (await session.stats())['session'],
        containsPair('decoded_frames', 3),
      );
      final cancel = RayKitCancellation();
      final active = session.readFrame(101, cancellation: cancel);
      final cancellation = expectLater(
        active,
        throwsA(
          isA<RayKitException>().having(
            (e) => e.code,
            'code',
            anyOf('cancelled', 'closed'),
          ),
        ),
      );
      cancel.cancel();
      final pending = expectLater(
        session.readFrame(102),
        throwsA(isA<RayKitException>().having((e) => e.code, 'code', 'closed')),
      );
      await session.close();
      await cancellation;
      await pending;
      expect(native.liveSessions(), baseline);
      expect(native.liveBuffers(), buffers);
    },
  );

  testWidgets(
    'standalone viewer presents a native frame and reopens a portable measurement',
    (tester) async {
      final controller = RayKitViewerController();
      final source = fixture('signed12');
      final presented = <RayKitPresentedFrame>[];
      final baseline = native.liveSessions();
      final buffers = native.liveBuffers();
      Widget app(RayKitSource source) => MaterialApp(
        home: Scaffold(
          body: RayKitViewer(
            source: source,
            controller: controller,
            onPresented: presented.add,
          ),
        ),
      );
      await tester.pumpWidget(app(source));
      await waitFor(tester, () => presented.isNotEmpty);
      expect(presented.single.source['frame'], 0);
      expect(find.textContaining('Original'), findsOneWidget);
      final record = await tester.runAsync(
        () => controller.session!.measure(0, measureRequest),
      );
      await tester.runAsync(() => controller.restoreMeasurement(record!));
      await tester.pump();
      expect(find.textContaining('5.00 millimeter'), findsOneWidget);

      await tester.tap(find.byTooltip('Rotate'));
      await waitFor(tester, () => presented.last.view['quarter_turns'] == 1);
      final revision = presented.last.revision;
      final observations = presented.length;
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      await waitFor(tester, () => native.liveSessions() == baseline);
      expect(presented.length, observations);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await waitFor(tester, () => presented.length > observations);
      expect(presented.last.revision, revision);
      expect(presented.last.view['quarter_turns'], 1);
      expect(controller.measurements, [record]);

      await tester.pumpWidget(app(fixture('signed12-big-endian')));
      await waitFor(tester, () => presented.last.revision != revision);
      expect(controller.measurements, isEmpty);
      expect(presented.last.view['quarter_turns'], 0);
      await tester.pumpWidget(const SizedBox());
      await waitFor(tester, () => native.liveSessions() == baseline);
      expect(native.liveBuffers(), buffers);
    },
  );
}

Future<void> waitFor(WidgetTester tester, bool Function() done) async {
  final watch = Stopwatch()..start();
  while (!done() && watch.elapsed < const Duration(seconds: 5)) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 10)),
    );
    await tester.pump();
  }
  expect(done(), isTrue);
}

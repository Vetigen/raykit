import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:crypto/crypto.dart';
import 'package:raykit/raykit.dart';
import 'package:raykit/src/display.dart';
import 'package:raykit/src/native.dart' as native;

File fixture(String name) => File('../../fixtures/generated/$name.dcm');

void main() {
  test(
    'Dart agrees with independent pixel digests and all portable measurements',
    () async {
      final reference =
          jsonDecode(
                await File(
                  '../../benchmarks/evidence/imaging-reference.json',
                ).readAsString(),
              )
              as Json;
      for (final entry in (reference['pixel_signatures'] as Json).entries) {
        final checked = entry.value as Json;
        final source = await RayKitSession.open(
          RayKitSource.file(fixture(entry.key)),
        );
        try {
          expect(
            sha256.convert((await source.readFrame(0)).pixels).toString(),
            checked['stored_sha256'],
          );
          expect(
            sha256.convert(await source.render(0, {})).toString(),
            checked['rgba_sha256'],
          );
        } finally {
          await source.close();
        }
      }
      final cases =
          (jsonDecode(
                    await File(
                      '../../tests/measurement-cases.json',
                    ).readAsString(),
                  )
                  as List)
              .cast<Json>();
      final session = await RayKitSession.open(
        RayKitSource.file(fixture('signed12')),
      );
      try {
        for (final row in cases) {
          final record = await session.measure(0, {
            'id': row['id'],
            'method': row['method'],
            'version': 1,
            'parameters': row['parameters'],
            'points': [
              for (final p in (row['points'] as List).cast<List>())
                {'x': p[0], 'y': p[1]},
            ],
          });
          expect(record['coordinate_system'], 'source_pixel_centers');
          final reference = record['source'] as Json;
          expect(reference['sop_class_uid'], '1.2.840.10008.5.1.4.1.1.1');
          expect(reference['instance_uid'], session.inspection.instanceUid);
          expect(reference['content_sha256'], session.inspection.contentSha256);
          expect(reference['frame'], 0);
          final values = (record['values'] as List).cast<Json>();
          expect(values.map((v) => v['unit']), row['units']);
          for (final (i, expected)
              in (row['values'] as List).cast<num>().indexed) {
            expect(values[i]['value'], closeTo(expected, 1e-12));
          }
          expect(
            await session.reopenMeasurement(
              jsonDecode(jsonEncode(record)) as Json,
            ),
            record,
          );
        }
      } finally {
        await session.close();
      }
      for (final name in ['us-gray-time', 'dx-luts']) {
        final session = await RayKitSession.open(
          RayKitSource.file(fixture(name)),
        );
        try {
          await expectLater(
            session.measure(0, {
              'id': name,
              'method': 'raykit:length',
              'version': 1,
              'points': [
                {'x': 0, 'y': 0},
                {'x': 1, 'y': 1},
              ],
              'parameters': {'require_mm': true},
            }),
            throwsA(
              isA<RayKitException>().having((e) => e.code, 'code', 'geometry'),
            ),
          );
        } finally {
          await session.close();
        }
      }
    },
  );

  test(
    'an indexed file retains verified original ranges with no Dart source copy',
    () async {
      final before = native.liveSessions();
      final folder = await Directory.systemTemp.createTemp(
        'raykit-index-test-',
      );
      final file = await fixture('cine-350').copy('${folder.path}/cine.dcm');
      final full = await RayKitSession.open(RayKitSource.file(file));
      final index = await full.createFrameIndex();
      final hash = full.inspection.contentSha256;
      final expected = [
        for (final n in [0, 175, 349]) await full.sample(n, 0, 0),
      ];
      expect((await full.stats())['native_input_copy_bytes'], 0);
      await full.close();
      try {
        final partial = await RayKitSession.open(
          RayKitSource.indexedFile(file, index),
          options: RayKitOpenOptions(
            expectedSha256: hash,
            revision: 'synthetic-index',
          ),
        );
        try {
          for (final (i, n) in [0, 175, 349].indexed) {
            expect(await partial.sample(n, 0, 0), expected[i]);
          }
          final stats = await partial.stats();
          final memory = stats['session'] as Json;
          expect(memory['range_reads'], 3);
          expect(memory['source_read_bytes'], lessThan(100000));
          expect(memory['frame_index_input_bytes'], index.bytes.length);
          expect(stats['native_input_copy_bytes'], 0);
          expect(partial.inspection.data['verification'], 'pinned_frame_index');
          await file.writeAsBytes([0], mode: FileMode.append);
          await expectLater(
            partial.readFrame(51),
            throwsA(
              isA<RayKitException>().having(
                (error) => error.code,
                'code',
                'integrity',
              ),
            ),
          );
        } finally {
          await partial.close();
        }
        await expectLater(
          RayKitSession.open(RayKitSource.indexedFile(file, index)),
          throwsA(
            isA<RayKitException>().having(
              (error) => error.code,
              'code',
              'integrity',
            ),
          ),
        );
        final token = RayKitCancellation()..cancel();
        await expectLater(
          RayKitSession.open(RayKitSource.file(file), cancellation: token),
          throwsA(
            isA<RayKitException>().having(
              (error) => error.code,
              'code',
              'cancelled',
            ),
          ),
        );
      } finally {
        await folder.delete(recursive: true);
      }
      expect(native.liveSessions(), before);
    },
  );

  test(
    'large volume and active plane use independent bounded caches and cancel old work',
    () async {
      for (final name in ['large-enhanced-ct', 'large-enhanced-mr']) {
        final source = await RayKitSession.open(
          RayKitSource.file(fixture(name)),
        );
        try {
          final candidates = await source.volumeCandidates();
          final volume = await source.buildVolume(
            0,
            candidates['revision'] as int,
          );
          expect(volume['voxel_bytes'], 314572800);
          expect(volume['dimensions'], [512, 512, 300]);
          expect(await source.sampleVolume([179.2, 204.8, 180]), 448);
          final plane = <String, Object?>{
            'center': [179.2, 204.8, 180.0],
            'dimensions': [128, 128],
            'spacing_xy': [0.9, 0.9],
            'orientation': {
              'kind': 'oblique',
              'axes': [1, 0, 0, 0, 0.7071067811865476, 0.7071067811865476],
            },
            'slab': {'kind': 'maximum', 'thickness_mm': 7.2},
          };
          final first = await source.reslice(
            plane,
            window: {'center': 450, 'width': 400},
          );
          final second = await source.reslice(
            plane,
            window: {'center': 460, 'width': 400},
            palette: 'hot',
          );
          expect(second.pixels, isNot(first.pixels));
          final stats = await source.stats();
          expect(stats['plane_cache_hits'], 1);
          expect(stats['planes_computed'], 1);
          expect(stats['plane_cache_bytes'], 128 * 128 * 4);
          expect(
            (stats['volume'] as Json)['peak_slice_cache_bytes'],
            lessThanOrEqualTo(16 * 1024 * 1024),
          );
          final token = RayKitCancellation();
          final pending = source.reslice({
            ...plane,
            'dimensions': [512, 512],
          }, cancellation: token);
          final rejected = expectLater(
            pending,
            throwsA(
              isA<RayKitException>().having((e) => e.code, 'code', 'cancelled'),
            ),
          );
          await Future<void>.delayed(const Duration(milliseconds: 5));
          token.cancel();
          await rejected;
          await source.reslice({
            ...plane,
            'center': [179.2, 204.8, 153.6],
          }, sampling: 'nearest');
          expect((await source.stats())['planes_computed'], 2);
        } finally {
          await source.close();
        }
      }
    },
  );

  testWidgets('packed stored samples match CPU at edges and under rotation', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final gpu = await MonochromeShader.testedProgram(
        'shaders/monochrome.frag',
      );
      expect(
        gpu,
        isNotNull,
        reason:
            'The local Flutter raster backend must pass the precision probe',
      );
      final session = await RayKitSession.open(
        RayKitSource.file(fixture('signed12')),
      );
      try {
        const windows = [
          {
            'window': {'center': -3180, 'width': 2, 'function': 'linear_exact'},
          },
          {
            'window': {'center': -3200, 'width': 300, 'function': 'sigmoid'},
            'palette': 'hot',
            'invert': true,
          },
          {
            'window': {'center': -3111, 'width': 120, 'function': 'linear'},
          },
        ];
        final frame = await session.readFrame(0, texture16: true);
        expect(frame.encoding, 'mono_u16_rg');
        final image = await decodeRgba(frame.pixels, frame.columns, frame.rows);
        try {
          for (final options in windows) {
            final cpu = await session.render(0, options);
            for (final rotated in [false, true]) {
              final recorder = ui.PictureRecorder();
              final canvas = ui.Canvas(recorder);
              final dpr = rotated ? 2 : 1;
              canvas.scale(dpr.toDouble());
              if (rotated) {
                canvas.translate(frame.rows - 0.5, 0.5);
                canvas.transform(
                  Float64List.fromList([
                    0,
                    1,
                    0,
                    0,
                    -1,
                    0,
                    0,
                    0,
                    0,
                    0,
                    1,
                    0,
                    0,
                    0,
                    0,
                    1,
                  ]),
                );
              } else {
                canvas.translate(0.5, 0.5);
              }
              gpu!.draw(
                canvas,
                image,
                MonochromeShader.uniforms(frame, options)!,
              );
              final picture = recorder.endRecording();
              final w = dpr * (rotated ? frame.rows : frame.columns);
              final h = dpr * (rotated ? frame.columns : frame.rows);
              final shown = await picture.toImage(w, h);
              try {
                final actual = (await shown.toByteData(
                  format: ui.ImageByteFormat.rawRgba,
                ))!.buffer.asUint8List();
                var delta = 0;
                for (var y = 0; y < h; y++) {
                  for (var x = 0; x < w; x++) {
                    final col = rotated ? y ~/ dpr : x;
                    final row = rotated ? frame.rows - 1 - x ~/ dpr : y;
                    for (var c = 0; c < 4; c++) {
                      final error =
                          (actual[(y * w + x) * 4 + c] -
                                  cpu[(row * frame.columns + col) * 4 + c])
                              .abs();
                      if (error > delta) delta = error;
                    }
                  }
                }
                expect(delta, lessThanOrEqualTo(1));
              } finally {
                shown.dispose();
                picture.dispose();
              }
            }
          }
          expect((await session.sample(0, 10, 10))['stored'], -1540);
        } finally {
          image.dispose();
        }
      } finally {
        await session.close();
      }
      final lut = await RayKitSession.open(
        RayKitSource.file(fixture('dx-luts')),
      );
      try {
        expect((await lut.readFrame(0, texture16: true)).encoding, 'rgba8');
      } finally {
        await lut.close();
      }
    });
  });

  testWidgets(
    'public Flutter controller uses one render, stable landmarks and a bounded scrub queue',
    (tester) async {
      final controller = RayKitViewerController();
      final views = <RayKitPresentedFrame>[];
      final before = native.liveSessions();
      Widget viewer(String file) => MaterialApp(
        home: Scaffold(
          body: RayKitViewer(
            source: RayKitSource.file(fixture(file)),
            controller: controller,
            onPresented: views.add,
          ),
        ),
      );
      await tester.pumpWidget(viewer('detail-signed12'));
      await waitFor(tester, () => views.isNotEmpty);
      Future<Json> stats() async =>
          (await tester.runAsync(() => controller.session!.stats()))!;
      final initial = await stats();
      final gestures = [
        controller.setRenderOptions({
          'window': {'center': -1500, 'width': 8},
        }),
      ];
      await waitFor(tester, () => views.length > 1);
      await gestures.single;
      final inWindow = await stats();
      expect(
        (inWindow['rendered_frame_bytes'] as int) -
            (initial['rendered_frame_bytes'] as int),
        16 * 1024 * 1024,
      );
      final moved = controller.setView(
        pan: const Offset(5, -3),
        zoom: 1.1,
        quarterTurns: 1,
      );
      await waitFor(tester, () => views.last.view['quarter_turns'] == 1);
      await moved;
      expect((await stats())['rendered_frames'], inWindow['rendered_frames']);
      expect(
        (await tester.runAsync(
          () => controller.samplePresented(1001, 550),
        ))!['stored'],
        -1499,
      );
      final imagePaints = controller.displayStats['image_paints'];
      final measurement = (await tester.runAsync(
        () => controller.session!.measure(0, {
          'id': 'landmark',
          'method': 'raykit:length',
          'version': 1,
          'points': [
            {'x': 128, 'y': 10},
            {'x': 134, 'y': 26},
          ],
        }),
      ))!;
      await tester.runAsync(() => controller.restoreMeasurement(measurement));
      await tester.pump();
      expect(controller.displayStats['image_paints'], imagePaints);

      final original = views.last.revision;
      await tester.pumpWidget(viewer('cine-350'));
      await waitFor(tester, () => views.last.revision != original);
      final cineStart = views.length;
      for (var step = 1; step <= 40; step++) {
        unawaited(
          controller.scrub(step <= 20 ? step * 9 : (40 - step) * 8).catchError((
            Object error,
          ) {
            if (error is! RayKitException || error.code != 'cancelled') {
              throw error;
            }
          }),
        );
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 8)),
        );
        await tester.pump();
      }
      final exact = controller.seek(349);
      await waitFor(tester, () => views.last.source['frame'] == 349);
      await exact;
      expect(views.length - cineStart, greaterThan(1));
      expect(
        ((await stats())['session'] as Json)['decoded_frames'],
        lessThan(43),
      );
      expect(
        (await tester.runAsync(
          () => controller.samplePresented(0, 0),
        ))!['values'],
        [189, 87, 75],
      );
      await tester.pumpWidget(const SizedBox());
      await waitFor(tester, () => native.liveSessions() == before);
    },
  );
}

Future<void> waitFor(WidgetTester tester, bool Function() done) async {
  final watch = Stopwatch()..start();
  while (!done() && watch.elapsed < const Duration(seconds: 10)) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 8)),
    );
    await tester.pump();
  }
  expect(done(), isTrue);
}

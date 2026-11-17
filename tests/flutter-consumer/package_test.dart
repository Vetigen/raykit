import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:raykit/raykit.dart';
import 'package:raykit/src/native.dart' as native;

import 'acceptance.dart';

void main() {
  testWidgets(
    'the installed Flutter package opens and measures the reference CT',
    (tester) async {
      await tester.runAsync(verifyInstalledRayKit);
      await verifyPresentedCt(tester);
    },
  );

  testWidgets(
    'synthetic host revocation clears retained images and measurements',
    (tester) async {
      final before = (native.liveSessions(), native.liveBuffers());
      final manifest =
          jsonDecode(
                (await tester.runAsync(
                  () => rootBundle.loadString('assets/raykit/manifest.json'),
                ))!,
              )
              as Json;
      Future<Uint8List> bytes(String name) async {
        final data = (await tester.runAsync(
          () => rootBundle.load('assets/raykit/$name'),
        ))!;
        return data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
      }

      const xray = 'signed12.dcm';
      const cine = 'cine-350.dcm';
      final radiograph = await bytes(xray);
      final ultrasound = await bytes(cine);
      RayKitOpenOptions pinned(String name) => RayKitOpenOptions(
        expectedSha256: (manifest[name] as Json)['sha256'] as String,
        expectedSize: (manifest[name] as Json)['bytes'] as int,
        revision: name,
      );
      final controller = RayKitViewerController();
      final draws = <String>[];
      Future<void> open(RayKitSource source, RayKitOpenOptions options) =>
          tester.pumpWidget(
            MaterialApp(
              home: Scaffold(
                body: RayKitViewer(
                  source: source,
                  options: options,
                  controller: controller,
                  onPresented: (frame) => draws.add(frame.revision),
                ),
              ),
            ),
          );

      final started = Completer<void>();
      final cancelled = Completer<void>();
      final slow = StreamController<Uint8List>(
        onListen: () => started.complete(),
        onCancel: () => cancelled.complete(),
      );
      await open(RayKitSource.reader((_) => slow.stream), pinned(cine));
      await untilPresented(tester, () => started.isCompleted);
      await open(RayKitSource.bytes(radiograph), pinned(xray));
      await untilPresented(
        tester,
        () => cancelled.isCompleted && controller.presented?.revision == xray,
      );
      slow.add(ultrasound);
      unawaited(slow.close());
      await tester.pump();
      expect(draws, isNotEmpty);
      expect(draws.toSet(), {xray});

      final session = controller.session!;
      final record = (await tester.runAsync(
        () => session.measure(0, {
          'id': 'synthetic-host-ruler',
          'method': 'raykit:length',
          'version': 1,
          'points': [
            {'x': 0, 'y': 0},
            {'x': 6, 'y': 16},
          ],
        }),
      ))!;
      final restoration = tester.runAsync(
        () => controller.restoreMeasurement(record),
      );
      await restoration;
      expect(controller.measurements.single, record);
      final host = ValueNotifier(false);
      var shutdown = false;
      host.addListener(
        () => unawaited(session.revoke().then((_) => shutdown = true)),
      );
      host.value = true;
      await untilPresented(tester, () => shutdown);
      host.dispose();
      await tester.pump();
      expect(controller.presented, isNull);
      expect(controller.session, isNull);
      expect(controller.measurements, isEmpty);
      expect(find.byType(RawImage), findsNothing);
      await tester.runAsync(
        () => expectLater(
          session.readFrame(0),
          throwsA(
            isA<RayKitException>().having((e) => e.code, 'code', 'closed'),
          ),
        ),
      );

      final drawn = draws.length;
      final badSources = [
        (radiograph, RayKitOpenOptions(expectedSha256: '0' * 64)),
        (radiograph.sublist(0, radiograph.length - 1), pinned(xray)),
        (
          radiograph,
          RayKitOpenOptions(expectedSha256: pinned(cine).expectedSha256),
        ),
      ];
      for (final (data, options) in badSources) {
        await open(RayKitSource.bytes(data), options);
        await untilPresented(
          tester,
          () => find.textContaining('integrity').evaluate().isNotEmpty,
        );
        expect(controller.presented, isNull);
        expect(controller.measurements, isEmpty);
      }
      expect(draws.length, drawn);
      await tester.pumpWidget(const SizedBox());
      expect((native.liveSessions(), native.liveBuffers()), before);
    },
  );
}

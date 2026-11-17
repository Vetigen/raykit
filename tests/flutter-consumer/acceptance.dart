import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:raykit/raykit.dart';

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
    debugPrint(
      jsonEncode({
        'sample': sample,
        'rgba_sha256': reference['rgba_sha256'],
        'length_mm': 7,
        'tamper_rejected': true,
      }),
    );
  } finally {
    await session.close();
  }
}

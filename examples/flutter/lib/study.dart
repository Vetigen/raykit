import 'dart:io';

import 'package:raykit/raykit.dart';

class StudyImage {
  const StudyImage(this.file, this.inspection, this.bytes);
  final File file;
  final RayKitInspection inspection;
  final int bytes;
  RayKitSource get source => RayKitSource.file(file);
  RayKitOpenOptions get options => RayKitOpenOptions(
    expectedSha256: inspection.contentSha256,
    expectedInstanceUid: inspection.instanceUid,
    expectedSize: bytes,
  );
}

Future<List<List<StudyImage>>> readStudy(
  Directory folder,
  RayKitCancellation cancellation,
) async {
  final groups = <(String, String), List<StudyImage>>{};
  var scanned = 0;
  await for (final item in folder.list(followLinks: false)) {
    cancellation.check();
    if (++scanned > 4096) {
      throw const RayKitException('limit', 'Study folder entries');
    }
    if (item is! File) continue;
    final count = await item.length();
    if (count < 132 || count > 192 * 1024 * 1024) continue;
    try {
      final open = await RayKitSession.inspect(
        RayKitSource.file(item),
        cancellation: cancellation,
        options: RayKitOpenOptions(expectedSize: count),
      );
      if (open.capabilities['frame_access'] != true) continue;
      final study = open.data['study_uid'] as String? ?? '';
      final series = open.data['series_uid'] as String? ?? open.instanceUid;
      groups
          .putIfAbsent((study, series), () => [])
          .add(StudyImage(item, open, count));
    } on RayKitException catch (error) {
      if (error.code == 'cancelled') rethrow;
    }
  }
  for (final series in groups.values) {
    final seen = <String>{};
    series.removeWhere((image) => !seen.add(image.inspection.contentSha256));
    final first = _plane(series.first);
    if (first == null) continue;
    final reference = (first['column_axis'] as List).cast<num>();
    final row = (first['row_axis'] as List).cast<num>();
    final normal = List.generate(
      3,
      (i) =>
          reference[(i + 1) % 3] * row[(i + 2) % 3] -
          reference[(i + 2) % 3] * row[(i + 1) % 3],
    );
    final sortable = series.every((member) {
      final plane = _plane(member);
      if (plane == null) return false;
      final x = (plane['column_axis'] as List).cast<num>();
      final y = (plane['row_axis'] as List).cast<num>();
      return List.generate(
        3,
        (i) => (reference[i] - x[i]).abs() + (row[i] - y[i]).abs(),
      ).every((delta) => delta < 1e-5);
    });
    if (sortable) {
      num position(StudyImage member) {
        final origin = (_plane(member)!['origin'] as List).cast<num>();
        return List.generate(
          3,
          (i) => normal[i] * origin[i],
        ).reduce((a, b) => a + b);
      }

      series.sort((a, b) => position(a).compareTo(position(b)));
    }
  }
  return groups.values.toList();
}

Json? _plane(StudyImage image) =>
    (image.inspection.data['initial_geometry'] as Json?)?['patient_plane']
        as Json?;

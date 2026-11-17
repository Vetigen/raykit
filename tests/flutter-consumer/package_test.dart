import 'package:flutter_test/flutter_test.dart';

import 'acceptance.dart';

void main() {
  testWidgets(
    'the installed Flutter package opens and measures the reference CT',
    (tester) async {
      await tester.runAsync(verifyInstalledRayKit);
    },
  );
}

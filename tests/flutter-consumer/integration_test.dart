import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import '../test/acceptance.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('the installed native asset opens and measures CT on iOS', (
    tester,
  ) async {
    await tester.runAsync(verifyInstalledRayKit);
  });
}

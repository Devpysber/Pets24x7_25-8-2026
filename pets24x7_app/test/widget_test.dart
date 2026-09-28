// The WebView itself needs a device, so these tests cover the app's own logic:
// which bottom tab a site address belongs to.

import 'package:flutter_test/flutter_test.dart';
import 'package:pets24x7_app/main.dart';

int tabFor(String url) => kTabs.indexWhere((t) => t.match(Uri.parse(url)));

void main() {
  test('site addresses select the right tab', () {
    expect(tabFor('https://pets24x7.com/'), 0);
    expect(tabFor('https://pets24x7.com/in/mumbai/some-listing-123/'), 0);
    expect(tabFor('https://pets24x7.com/search/?q=vet'), 1);
    expect(tabFor('https://pets24x7.com/membership/?for=business'), 2);
    expect(tabFor('https://pets24x7.com/dashboard/parent/'), 3);
    expect(tabFor('https://pets24x7.com/parent-login/?next=/'), 3);
    expect(tabFor('https://pets24x7.com/delete-account/'), 3);
  });
}

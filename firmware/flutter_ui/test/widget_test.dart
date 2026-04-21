import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_ui/main.dart';

void main() {
  testWidgets('renders Device Bridge shell', (WidgetTester tester) async {
    await tester.pumpWidget(const DeviceBridgeApp());
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });
}

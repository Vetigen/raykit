import 'dart:convert';
import 'dart:io';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:raykit/raykit.dart';

void main() => runApp(
  MaterialApp(
    title: 'RayKit',
    theme: ThemeData(
      colorScheme: ColorScheme.fromSeed(
        seedColor: Colors.teal,
        brightness: Brightness.dark,
      ),
    ),
    home: const ExampleViewer(),
  ),
);

class ExampleViewer extends StatefulWidget {
  const ExampleViewer({super.key});
  @override
  State<ExampleViewer> createState() => _ExampleViewerState();
}

class _ExampleViewerState extends State<ExampleViewer> {
  final _controller = RayKitViewerController();
  RayKitSource? _source;

  void _synthetic(String file) {
    setState(() {
      _source = RayKitSource.reader((cancellation) async* {
        final data = await rootBundle.load('assets/raykit/$file');
        cancellation.check();
        yield data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
      });
    });
  }

  Future<void> _pick() async {
    final file = await openFile();
    if (file == null || !mounted) return;
    setState(() => _source = RayKitSource.file(File(file.path)));
  }

  Future<void> _export() async {
    final measurements = _controller.measurements;
    if (measurements.isEmpty) return;
    await Clipboard.setData(ClipboardData(text: jsonEncode(measurements)));
    _message('Measurement JSON copied.');
  }

  Future<void> _restore() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text;
    if (text == null || text.length > 128 * 1024) {
      _message('Clipboard does not contain a supported measurement file.');
      return;
    }
    try {
      final records = jsonDecode(text) as List;
      if (records.isEmpty || records.length > 128) {
        throw const FormatException('Invalid measurement list');
      }
      for (final record in records.cast<Json>()) {
        await _controller.restoreMeasurement(record);
      }
      _message('Measurements reopened.');
    } on RayKitException catch (error) {
      _message(error.toString());
    } catch (_) {
      _message('Invalid measurement JSON.');
    }
  }

  void _message(String message) {
    if (mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final source = _source;
    return Scaffold(
      appBar: AppBar(
        title: const Text('RayKit Viewer'),
        actions: [
          IconButton(
            tooltip: 'Open local DICOM',
            onPressed: _pick,
            icon: const Icon(Icons.folder_open),
          ),
          if (source != null)
            IconButton(
              tooltip: 'Close image',
              onPressed: () => setState(() => _source = null),
              icon: const Icon(Icons.close),
            ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            Wrap(
              spacing: 8,
              children: [
                TextButton(
                  onPressed: () => _synthetic('signed12.dcm'),
                  child: const Text('Synthetic radiograph'),
                ),
                TextButton(
                  onPressed: () => _synthetic('cine-350.dcm'),
                  child: const Text('350-frame ultrasound'),
                ),
                if (source != null) ...[
                  TextButton(
                    onPressed: _export,
                    child: const Text('Copy measurements'),
                  ),
                  TextButton(
                    onPressed: _restore,
                    child: const Text('Paste measurements'),
                  ),
                ],
              ],
            ),
            Expanded(
              child: source == null
                  ? const Center(child: Text('Choose a local DICOM file.'))
                  : RayKitViewer(source: source, controller: _controller),
            ),
          ],
        ),
      ),
    );
  }
}

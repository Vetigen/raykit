import 'dart:async';
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
  RayKitOpenOptions _options = const RayKitOpenOptions();
  RayKitDisplayMode _mode = const bool.fromEnvironment('RAYKIT_SHADER')
      ? RayKitDisplayMode.shader
      : RayKitDisplayMode.auto;
  RayKitCancellation? _preparing;
  ({
    Directory folder,
    File file,
    RayKitFrameIndex index,
    RayKitOpenOptions options,
  })?
  _indexed;
  bool _volumeAvailable = false;

  void _select(
    RayKitSource? source, [
    RayKitOpenOptions options = const RayKitOpenOptions(),
  ]) {
    _preparing?.cancel();
    setState(() {
      _source = source;
      _options = options;
      _volumeAvailable = false;
    });
  }

  void _synthetic(String file) {
    _select(
      RayKitSource.reader((cancellation) async* {
        final data = await rootBundle.load('assets/raykit/$file');
        cancellation.check();
        yield data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
      }),
    );
  }

  Future<void> _pick() async {
    final file = await openFile();
    if (file == null || !mounted) return;
    _select(RayKitSource.file(File(file.path)));
  }

  Future<void> _indexedUltrasound() async {
    _preparing?.cancel();
    final saved = _indexed;
    if (saved != null) {
      _select(RayKitSource.indexedFile(saved.file, saved.index), saved.options);
      return;
    }
    final token = _preparing = RayKitCancellation();
    Directory? folder;
    try {
      const name = 'cine-350.dcm';
      final manifest =
          jsonDecode(await rootBundle.loadString('assets/raykit/manifest.json'))
              as Json;
      final identity = manifest[name] as Json;
      final options = RayKitOpenOptions(
        expectedSha256: identity['sha256'] as String,
        expectedSize: identity['bytes'] as int,
      );
      final asset = await rootBundle.load('assets/raykit/$name');
      token.check();
      folder = await Directory.systemTemp.createTemp('raykit-example-');
      final file = await File('${folder.path}/$name').writeAsBytes(
        asset.buffer.asUint8List(asset.offsetInBytes, asset.lengthInBytes),
      );
      final full = await RayKitSession.open(
        RayKitSource.file(file),
        options: options,
        cancellation: token,
      );
      final RayKitFrameIndex index;
      try {
        index = await full.createFrameIndex(cancellation: token);
      } finally {
        await full.close();
      }
      token.check();
      if (!mounted) return;
      _indexed = (folder: folder, file: file, index: index, options: options);
      folder = null;
      _select(RayKitSource.indexedFile(file, index), options);
    } catch (error) {
      if (!token.isCancelled) {
        _message(
          error is RayKitException
              ? error.toString()
              : 'Unable to prepare indexed ultrasound',
        );
      }
    } finally {
      await folder?.delete(recursive: true);
    }
  }

  void _volume() {
    final session = _controller.session;
    if (session == null) return;
    unawaited(
      showDialog<void>(
        context: context,
        builder: (context) => Dialog.fullscreen(
          child: Scaffold(
            appBar: AppBar(title: const Text('CT/MR volume')),
            body: SafeArea(child: RayKitVolumeView(session: session)),
          ),
        ),
      ),
    );
  }

  @override
  void dispose() {
    _preparing?.cancel();
    final session = _controller.session;
    final indexed = _indexed;
    unawaited(() async {
      await session?.close();
      await indexed?.folder.delete(recursive: true);
    }());
    super.dispose();
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
              onPressed: () => _select(null),
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
                  onPressed: () => _synthetic('detail-signed12.dcm'),
                  child: const Text('2048px detail chart'),
                ),
                TextButton(
                  onPressed: _indexedUltrasound,
                  child: const Text('Indexed ultrasound'),
                ),
                TextButton(
                  onPressed: () => _synthetic('large-enhanced-ct.dcm'),
                  child: const Text('300-slice CT'),
                ),
                TextButton(
                  onPressed: () => _synthetic('large-enhanced-mr.dcm'),
                  child: const Text('300-slice MR'),
                ),
                if (_volumeAvailable)
                  TextButton(onPressed: _volume, child: const Text('Volume')),
                FilterChip(
                  label: const Text('16-bit shader'),
                  selected: _mode == RayKitDisplayMode.shader,
                  onSelected: (value) => setState(
                    () => _mode = value
                        ? RayKitDisplayMode.shader
                        : RayKitDisplayMode.auto,
                  ),
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
                  : RayKitViewer(
                      source: source,
                      controller: _controller,
                      options: _options,
                      displayMode: _mode,
                      onPresented: (_) {
                        final possible =
                            _controller
                                .session
                                ?.inspection
                                .capabilities['volume_candidate'] ==
                            true;
                        if (mounted && possible != _volumeAvailable) {
                          setState(() => _volumeAvailable = possible);
                        }
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:desktop_drop/desktop_drop.dart';
import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:raykit/raykit.dart';

import 'study.dart';
import 'synthetic_live.dart';

typedef VerifyPoint = ({int frame, int x, int y, String? measurement});

void main(List<String> args) {
  VerifyPoint? verify;
  if (args.isNotEmpty && args.first == '--verify') {
    final values = args.skip(2).take(3).map(int.tryParse).toList();
    if ((args.length != 5 && args.length != 6) ||
        values.any((value) => value == null || value < 0)) {
      stderr.writeln('Usage: RayKit --verify SOURCE FRAME X Y [MEASUREMENT]');
      exit(2);
    }
    verify = (
      frame: values[0]!,
      x: values[1]!,
      y: values[2]!,
      measurement: args.length == 6 ? args[5] : null,
    );
  }
  runApp(
    MaterialApp(
      title: 'RayKit by Vetigen',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: Colors.teal,
          brightness: Brightness.dark,
        ),
      ),
      home: ExampleViewer(
        initialPath: verify == null
            ? (args.length == 1 ? args.single : null)
            : args[1],
        verify: verify,
      ),
    ),
  );
}

class ExampleViewer extends StatefulWidget {
  const ExampleViewer({super.key, this.initialPath, this.verify});
  final String? initialPath;
  final VerifyPoint? verify;
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
  List<List<StudyImage>> _study = [];
  int _series = 0;
  int _instance = 0;
  bool _scanning = false;
  bool _reported = false;

  bool get _desktop =>
      Platform.isLinux || Platform.isMacOS || Platform.isWindows;

  @override
  void initState() {
    super.initState();
    if (widget.initialPath case final path?) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) unawaited(_openPath(path));
      });
    }
  }

  void _select(
    RayKitSource? source, [
    RayKitOpenOptions options = const RayKitOpenOptions(),
  ]) {
    _preparing?.cancel();
    setState(() {
      _study = [];
      _scanning = false;
      _source = source;
      _options = options;
      _volumeAvailable = false;
    });
  }

  void _synthetic(String file) {
    _select(_asset(file));
  }

  RayKitSource _asset(String file) =>
      RayKitSource.reader((cancellation) async* {
        final data = await rootBundle.load('assets/raykit/$file');
        cancellation.check();
        yield data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
      });

  Future<void> _pick() async {
    final file = await openFile();
    if (file == null || !mounted) return;
    _select(RayKitSource.file(File(file.path)));
  }

  Future<void> _openPath(String path) async {
    final type = await FileSystemEntity.type(path);
    if (!mounted) return;
    if (type == FileSystemEntityType.file) {
      _select(RayKitSource.file(File(path)));
    } else if (type == FileSystemEntityType.directory) {
      await _openStudy(Directory(path));
    } else {
      _message('Choose a DICOM file or study folder.');
    }
  }

  Future<void> _pickStudy() async {
    final path = await getDirectoryPath();
    if (path != null && mounted) await _openStudy(Directory(path));
  }

  Future<void> _openStudy(Directory directory) async {
    _preparing?.cancel();
    final token = _preparing = RayKitCancellation();
    setState(() => _scanning = true);
    try {
      final study = await readStudy(directory, token);
      token.check();
      if (!mounted) return;
      if (study.isEmpty) {
        _message('The folder contains no supported DICOM images.');
        return;
      }
      _study = study;
      _selectImage(0, 0);
    } catch (error) {
      if (!token.isCancelled) {
        _message(
          error is RayKitException
              ? error.toString()
              : 'Unable to read the study folder.',
        );
      }
    } finally {
      if (mounted && _preparing == token) setState(() => _scanning = false);
    }
  }

  void _selectImage(int series, int instance) {
    final image = _study[series][instance];
    setState(() {
      _series = series;
      _instance = instance;
      _source = image.source;
      _options = image.options;
      _volumeAvailable = false;
    });
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

  Future<void> _volume() async {
    final session = _controller.session;
    if (session == null) return;
    if (_study.isNotEmpty) {
      _preparing?.cancel();
      final token = _preparing = RayKitCancellation();
      try {
        for (final item in _study[_series]) {
          if (item.inspection.contentSha256 ==
              session.inspection.contentSha256) {
            continue;
          }
          await session.addVolumeSource(
            item.source,
            options: item.options,
            cancellation: token,
          );
        }
        token.check();
      } catch (error) {
        if (!token.isCancelled) {
          _message(
            error is RayKitException
                ? error.toString()
                : 'Unable to build the volume.',
          );
        }
        return;
      }
    }
    if (!mounted || _controller.session != session) return;
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

  Future<void> _compareMr() async {
    final a = await RayKitSession.open(_asset('comparison-mr-t1.dcm'));
    RayKitSession? b;
    try {
      b = await RayKitSession.open(_asset('comparison-mr-t2.dcm'));
      final left = await a.frameInfo(0);
      final right = b;
      final space =
          (left['source'] as Json)['frame_of_reference_uid'] as String;
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (_) => Dialog.fullscreen(
          child: Scaffold(
            appBar: AppBar(title: const Text('Compare synthetic T1 and T2')),
            body: RayKitComparison(
              session: a,
              otherSession: right,
              registration: (
                leftSha256: a.inspection.contentSha256,
                leftRevision: a.revision,
                rightSha256: right.inspection.contentSha256,
                rightRevision: right.revision,
                frameOfReference: space,
              ),
            ),
          ),
        ),
      );
    } finally {
      await a.close();
      await b?.close();
    }
  }

  Future<void> _live() => showDialog<void>(
    context: context,
    builder: (_) => Dialog.fullscreen(
      child: SyntheticLive(source: _asset('us-rgb-planar.dcm')),
    ),
  );

  Future<void> _acquisitions() async {
    const revision = 'synthetic-series-v1';
    final manifest =
        jsonDecode(await rootBundle.loadString('assets/raykit/manifest.json'))
            as Json;
    final series = RayKitProgressiveSeries(
      revision: revision,
      studyUid: '2.25.100',
      seriesUid: '2.25.901',
    );
    final timers = <Timer>[];
    for (final (arrival, i) in [0, 2, 1].indexed) {
      final file = 'classic-ct-$i.dcm';
      final row = manifest[file] as Json;
      timers.add(
        Timer(Duration(milliseconds: 30 + arrival * 850), () {
          series.append(revision, i, [
            RayKitSeriesMember(
              instanceUid: '2.25.${911 + i}',
              revision: revision,
              source: _asset(file),
              sha256: row['sha256'] as String,
              bytes: row['bytes'] as int,
              acquiredAt: DateTime.fromMillisecondsSinceEpoch(
                i * 1000,
                isUtc: true,
              ),
            ),
          ]);
        }),
      );
    }
    try {
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (_) => Dialog.fullscreen(
          child: Scaffold(
            appBar: AppBar(
              title: const Text('Synthetic acquisitions'),
              actions: [
                ListenableBuilder(
                  listenable: series,
                  builder: (context, _) => TextButton(
                    onPressed: () => series.setConnected(!series.connected),
                    child: Text(series.connected ? 'Disconnect' : 'Reconnect'),
                  ),
                ),
              ],
            ),
            body: RayKitLiveSeriesView(series: series),
          ),
        ),
      );
    } finally {
      for (final timer in timers) {
        timer.cancel();
      }
      series.dispose();
    }
  }

  void _compare() {
    final session = _controller.session;
    final frame = _controller.presented?.source['frame'];
    if (session == null || frame is! int) return;
    unawaited(
      showDialog<void>(
        context: context,
        builder: (_) => Dialog.fullscreen(
          child: Scaffold(
            appBar: AppBar(title: const Text('Compare same source')),
            body: SafeArea(
              child: RayKitComparison(
                session: session,
                initialFrame: frame,
                displayMode: _mode,
                onMeasurement: (record) =>
                    unawaited(_controller.restoreMeasurement(record)),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Iterable<List<StudyImage>> get _otherSeries {
    if (_study.isEmpty) return [];
    final study = _study[_series].first.inspection.data['study_uid'];
    return _study.indexed
        .where(
          (entry) =>
              entry.$1 != _series &&
              study != null &&
              entry.$2.first.inspection.data['study_uid'] == study,
        )
        .map((entry) => entry.$2);
  }

  Future<void> _compareStudy() async {
    final session = _controller.session;
    final frame = _controller.presented?.source['frame'];
    if (session == null || frame is! int) return;
    final selected = await showDialog<StudyImage>(
      context: context,
      builder: (context) => SimpleDialog(
        title: const Text('Select a comparison series'),
        children: [
          for (final (index, series) in _otherSeries.indexed)
            SimpleDialogOption(
              onPressed: () => Navigator.pop(context, series.first),
              child: Text(
                series.first.inspection.seriesDescription ??
                    'Series ${index + 1} · ${series.first.inspection.object}',
              ),
            ),
        ],
      ),
    );
    if (selected == null || !mounted || _controller.session != session) return;
    RayKitSession? other;
    try {
      final second = other = await RayKitSession.open(
        selected.source,
        options: selected.options,
      );
      if (!mounted || _controller.session != session) return;
      await showDialog<void>(
        context: context,
        builder: (_) => Dialog.fullscreen(
          child: Scaffold(
            appBar: AppBar(title: const Text('Compare study series')),
            body: SafeArea(
              child: RayKitComparison(
                session: session,
                otherSession: second,
                initialFrame: frame,
                displayMode: _mode,
              ),
            ),
          ),
        ),
      );
    } on RayKitException catch (error) {
      _message(error.toString());
    } finally {
      await other?.close();
    }
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
    await _restoreRecords(text);
  }

  Future<void> _restoreRecords(String text) async {
    try {
      final json = jsonDecode(text);
      final records = json is List ? json : [json];
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

  Future<void> _saveFile() async {
    final records = _controller.measurements;
    if (records.isEmpty) {
      _message('Create a measurement first.');
      return;
    }
    final location = await getSaveLocation(
      suggestedName: 'raykit-measurements.json',
    );
    if (location == null) return;
    try {
      final file = await File(location.path).create(exclusive: true);
      await file.writeAsString(jsonEncode(records), flush: true);
      _message('Measurements saved.');
    } on FileSystemException {
      _message('Unable to write a new measurement file.');
    }
  }

  Future<void> _openMeasurements() async {
    final selected = await openFile(
      acceptedTypeGroups: [
        const XTypeGroup(label: 'Measurement JSON', extensions: ['json']),
      ],
    );
    if (selected == null) return;
    if (await selected.length() > 128 * 1024) {
      _message('The measurement file is too large.');
      return;
    }
    await _restoreRecords(await selected.readAsString());
  }

  void _message(String message) {
    if (mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(message)));
    }
  }

  Future<void> _verify(RayKitPresentedFrame frame) async {
    final session = _controller.session;
    final requested = widget.verify;
    if (requested == null || _reported || session == null) return;
    _reported = true;
    try {
      if (frame.source['frame'] != requested.frame) {
        throw const RayKitException(
          'invalid_request',
          'Requested frame is unavailable',
        );
      }
      final sample = await session.sampleAt(
        requested.frame,
        requested.x,
        requested.y,
      );
      Json? measurement;
      if (requested.measurement case final path?) {
        final input = File(path);
        if (await input.length() > 128 * 1024) {
          throw const RayKitException('limit', 'Measurement JSON bytes');
        }
        final data = jsonDecode(await input.readAsString());
        final source = data is Json ? data['source'] : null;
        if (data is! Json ||
            source is! Json ||
            source['frame'] != requested.frame) {
          throw const RayKitException('invalid_request', 'Measurement frame');
        }
        final verified = await session.verifyMeasurement(data);
        measurement = await _controller.restoreMeasurement(verified);
      }
      final stats = await session.stats();
      final output = jsonEncode({
        'implementation': 'native-flutter',
        'renderer': frame.renderer,
        'sample': sample,
        'measurement': ?measurement,
        'decoded_frames': (stats['session'] as Json)['decoded_frames'],
      });
      if (Platform.environment['RAYKIT_VERIFY_OUTPUT'] case final path?) {
        await File(path).writeAsString(output);
      } else {
        stdout.writeln(output);
      }
      await session.revoke();
      exit(0);
    } on RayKitException catch (error) {
      stderr.writeln(error.toString());
      exit(1);
    } on FormatException {
      stderr.writeln('Invalid measurement JSON.');
      exit(1);
    } on FileSystemException {
      stderr.writeln('Unable to read the measurement file.');
      exit(1);
    }
  }

  @override
  Widget build(BuildContext context) {
    final source = _source;
    final body = SafeArea(
      child: Column(
        children: [
          if (_scanning) const LinearProgressIndicator(),
          if (_study.isNotEmpty)
            Wrap(
              children: [
                DropdownButton<int>(
                  value: _series,
                  items: [
                    for (var i = 0; i < _study.length; i++)
                      DropdownMenuItem(
                        value: i,
                        child: Text(
                          _study[i].first.inspection.seriesDescription ??
                              'Series ${i + 1} · ${_study[i].first.inspection.object}',
                        ),
                      ),
                  ],
                  onChanged: (i) {
                    if (i != null) _selectImage(i, 0);
                  },
                ),
                DropdownButton<int>(
                  value: _instance,
                  items: [
                    for (var i = 0; i < _study[_series].length; i++)
                      DropdownMenuItem(
                        value: i,
                        child: Text('Instance ${i + 1}'),
                      ),
                  ],
                  onChanged: (i) {
                    if (i != null) _selectImage(_series, i);
                  },
                ),
              ],
            ),
          _controls(source),
          Expanded(
            child: source == null
                ? Center(
                    child: Text(
                      _desktop
                          ? 'Open or drop a DICOM file or study folder.'
                          : 'Choose a local DICOM file.',
                    ),
                  )
                : RayKitViewer(
                    source: source,
                    initialFrame: widget.verify?.frame ?? 0,
                    controller: _controller,
                    options: _options,
                    displayMode: _mode,
                    onPresented: (frame) {
                      unawaited(_verify(frame));
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
    );
    return Scaffold(
      appBar: AppBar(
        title: const Text('RayKit by Vetigen'),
        actions: [
          IconButton(
            tooltip: 'Open local DICOM',
            onPressed: _pick,
            icon: const Icon(Icons.folder_open),
          ),
          if (_desktop)
            IconButton(
              tooltip: 'Open study folder',
              onPressed: _pickStudy,
              icon: const Icon(Icons.folder_copy_outlined),
            ),
          if (source != null)
            IconButton(
              tooltip: 'Close image',
              onPressed: () => _select(null),
              icon: const Icon(Icons.close),
            ),
        ],
      ),
      body: _desktop
          ? DropTarget(
              onDragDone: (details) {
                if (details.files.length == 1) {
                  unawaited(_openPath(details.files.single.path));
                }
              },
              child: body,
            )
          : body,
    );
  }

  Widget _controls(RayKitSource? source) => Wrap(
    spacing: 8,
    children: [
      _menu('Synthetic cases', {
        'Synthetic radiograph': () => _synthetic('signed12.dcm'),
        '2048px detail chart': () => _synthetic('detail-signed12.dcm'),
        'Indexed ultrasound': _indexedUltrasound,
        '350-frame ultrasound': () => _synthetic('cine-350.dcm'),
        '300-slice CT': () => _synthetic('large-enhanced-ct.dcm'),
        'CT with named windows': () => _synthetic('comparison-ct.dcm'),
        '300-slice MR': () => _synthetic('large-enhanced-mr.dcm'),
        'Compare T1 and T2': _compareMr,
        'Synthetic live stream': _live,
        'Follow synthetic acquisitions': _acquisitions,
      }),
      if (source != null)
        _menu('Measurements', {
          'Copy measurements': _export,
          'Paste measurements': _restore,
          if (_desktop) 'Save measurements': _saveFile,
          if (_desktop) 'Open measurements': _openMeasurements,
        }),
      if (_volumeAvailable)
        TextButton(onPressed: _volume, child: const Text('Volume')),
      if (_volumeAvailable)
        TextButton(
          onPressed: _compare,
          child: const Text('Compare same source'),
        ),
      if (_otherSeries.isNotEmpty)
        TextButton(
          onPressed: _compareStudy,
          child: const Text('Compare study series'),
        ),
      FilterChip(
        label: const Text('16-bit shader'),
        selected: _mode == RayKitDisplayMode.shader,
        onSelected: (value) => setState(
          () =>
              _mode = value ? RayKitDisplayMode.shader : RayKitDisplayMode.auto,
        ),
      ),
    ],
  );

  Widget _menu(String label, Map<String, VoidCallback> actions) =>
      PopupMenuButton<String>(
        tooltip: label,
        onSelected: (action) => actions[action]?.call(),
        itemBuilder: (_) => [
          for (final name in actions.keys)
            PopupMenuItem(value: name, child: Text(name)),
        ],
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          child: Text(label),
        ),
      );
}

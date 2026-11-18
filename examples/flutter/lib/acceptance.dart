import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show debugPrintSynchronously;
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
import 'package:raykit/raykit.dart';

const _commit = String.fromEnvironment(
  'RAYKIT_COMMIT',
  defaultValue: 'development',
);
const _device = String.fromEnvironment(
  'RAYKIT_DEVICE',
  defaultValue: 'unspecified',
);
const _soakSeconds = int.fromEnvironment(
  'RAYKIT_SOAK_SECONDS',
  defaultValue: 600,
);
const _repeats = int.fromEnvironment(
  'RAYKIT_ACCEPTANCE_REPEATS',
  defaultValue: 5,
);

void main() => runApp(const MaterialApp(home: _Acceptance()));

class _Acceptance extends StatefulWidget {
  const _Acceptance();
  @override
  State<_Acceptance> createState() => _AcceptanceState();
}

class _AcceptanceState extends State<_Acceptance> {
  final _controllers = List.generate(4, (_) => RayKitViewerController());
  final _clock = Stopwatch()..start();
  final _draws = <({int frame, int time})>[];
  final _timings = <({int time, int build, int raster})>[];
  final _rss = <int>[];
  final _results = <String, Object?>{};
  final _assets = <String, File>{};
  List<RayKitSource> _sources = [];
  List<Completer<RayKitPresentedFrame>> _ready = [];
  Directory? _folder;
  late Json _manifest;
  late AppLifecycleListener _lifecycle;
  Timer? _sampling;
  RayKitOpenOptions _options = const RayKitOpenOptions();
  RayKitDisplayMode _display = RayKitDisplayMode.cpu;
  bool _hidden = false;
  bool _soaking = false;
  bool _interrupted = false;
  int _epoch = 0;
  String _status = 'Starting synthetic imaging acceptance';
  RayKitViewerController get _primary => _controllers.first;

  @override
  void initState() {
    super.initState();
    _lifecycle = AppLifecycleListener(
      onHide: () {
        _hidden = true;
        if (_soaking) _interrupted = true;
      },
      onResume: () => _hidden = false,
    );
    SchedulerBinding.instance.addTimingsCallback(_recordTiming);
    WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(_run()));
  }

  void _recordTiming(List<FrameTiming> rows) {
    if (!_soaking) return;
    for (final row in rows) {
      _timings.add((
        time: _clock.elapsedMicroseconds,
        build: row.buildDuration.inMicroseconds,
        raster: row.rasterDuration.inMicroseconds,
      ));
    }
  }

  void _present(int slot, int epoch, RayKitPresentedFrame event) {
    if (_epoch != epoch) return;
    if (event.source['content_sha256'] != _options.expectedSha256) {
      if (!_ready[slot].isCompleted) {
        _ready[slot].completeError(StateError('Source SHA-256 mismatch'));
      }
      return;
    }
    if (slot == 0) {
      _draws.add((
        frame: event.source['frame'] as int,
        time: _clock.elapsedMicroseconds,
      ));
    }
    if (!_ready[slot].isCompleted) _ready[slot].complete(event);
  }

  Future<List<RayKitPresentedFrame>> _open(
    String name, {
    int panels = 1,
    RayKitDisplayMode mode = RayKitDisplayMode.cpu,
    RayKitFrameIndex? index,
  }) async {
    final file = _assets[name] ?? await _copyFixture(name);
    final expected = _manifest[name] as Json;
    final options = RayKitOpenOptions(
      expectedSha256: expected['sha256'] as String,
      expectedSize: expected['bytes'] as int,
    );
    setState(() {
      _options = options;
      _display = mode;
      _sources = List.generate(
        panels,
        (_) => index == null
            ? RayKitSource.file(file)
            : RayKitSource.indexedFile(file, index),
      );
      _ready = List.generate(panels, (_) => Completer<RayKitPresentedFrame>());
      _draws.clear();
      _epoch++;
      _status = '$name · $panels ${panels == 1 ? 'panel' : 'panels'}';
    });
    return Future.wait(
      _ready.map((c) => c.future),
    ).timeout(const Duration(seconds: 30));
  }

  Future<File> _copyFixture(String name) async {
    final data = await rootBundle.load('assets/raykit/$name');
    final file = await File('${_folder!.path}/$name').writeAsBytes(
      data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
    );
    return _assets[name] = file;
  }

  Future<Json> _radiograph(RayKitDisplayMode mode) async {
    const file = 'detail-signed12.dcm';
    await _copyFixture(file);
    final cold = <double>[],
        reopen = <double>[],
        window = <double>[],
        view = <double>[];
    String? renderer;
    for (var run = 0; run < _repeats; run++) {
      await _closePanels();
      final time = Stopwatch()..start();
      renderer = (await _open(file, mode: mode)).single.renderer;
      cold.add(time.elapsedMicroseconds / 1000);
      time.reset();
      await _open(file, mode: mode);
      reopen.add(time.elapsedMicroseconds / 1000);
      for (var i = 0; i < 12; i++) {
        time.reset();
        await _primary.setRenderOptions({
          'window': {
            'center': -1504 + i,
            'width': 7 + i,
            'function': 'linear_exact',
          },
          'palette': i.isEven ? 'gray' : 'hot',
        });
        window.add(time.elapsedMicroseconds / 1000);
        time.reset();
        await _primary.setView(
          pan: Offset(i.toDouble(), 0),
          zoom: 1.0 + i / 24,
          quarterTurns: i % 4,
        );
        view.add(time.elapsedMicroseconds / 1000);
      }
      if ((await _primary.samplePresented(1001, 550))['stored'] != -1499) {
        throw StateError('Incorrect stored radiograph pixel');
      }
    }
    return {
      'renderer': renderer,
      'open_ms': _metric(cold),
      'reopen_ms': _metric(reopen),
      'window_ms': _metric(window),
      'pose_ms': _metric(view),
      'session': await _primary.session!.stats(),
      'display': _primary.displayStats,
    };
  }

  Future<Json> _cine() async {
    await _open('cine-350.dcm');
    final session = _primary.session!;
    final seeks = <double>[];
    for (var i = 0; i < 20; i++) {
      final watch = Stopwatch()..start();
      await _primary.seek((i * 97 + 21) % 350);
      seeks.add(watch.elapsedMicroseconds / 1000);
    }
    final releases = <double>[],
        intermediates = <double>[],
        decodes = <double>[],
        copies = <double>[];
    for (var run = 0; run < _repeats; run++) {
      final before = await session.stats();
      final from = _draws.length;
      final watch = Stopwatch()..start();
      final pending = <Future<void>>[];
      var last = 0;
      for (var i = 0; i < 40; i++) {
        await Future<void>.delayed(
          Duration(
            microseconds: math.max(0, i * 8000 - watch.elapsedMicroseconds),
          ),
        );
        last = run.isEven || i < 20 ? 35 + i * 8 : 187 - (i - 19) * 7;
        pending.add(
          _primary.scrub(last).catchError((Object error) {
            if (error is! RayKitException || error.code != 'cancelled') {
              throw error;
            }
          }),
        );
      }
      final release = _clock.elapsedMicroseconds;
      await _primary.settle();
      await Future.wait(pending);
      if (_primary.presented?.source['frame'] != last) {
        throw StateError('Incorrect final scrub frame');
      }
      releases.add(math.max(0, (_draws.last.time - release) / 1000));
      intermediates.add(
        _draws
            .skip(from)
            .map((value) => value.frame)
            .toSet()
            .difference({last})
            .length
            .toDouble(),
      );
      final after = await session.stats();
      decodes.add(
        ((after['session'] as Json)['decoded_frames'] as num).toDouble() -
            ((before['session'] as Json)['decoded_frames'] as num),
      );
      copies.add(
        (after['native_output_copy_bytes'] as num).toDouble() -
            (before['native_output_copy_bytes'] as num),
      );
    }
    await _primary.seek(349);
    final original = (await _primary.samplePresented(0, 0))['values'];
    if (jsonEncode(original) != '[189,87,75]') {
      throw StateError('Incorrect ultrasound sample');
    }
    return {
      'seek_ms': _metric(seeks),
      'release_ms': _metric(releases),
      'intermediate_frames': _metric(intermediates),
      'decode_count': _metric(decodes),
      'output_copy_bytes': _metric(copies),
      'end_sample': original,
    };
  }

  Future<Json> _volume(String name) async {
    final build = <double>[],
        axial = <double>[],
        coronal = <double>[],
        mip = <double>[],
        moved = <double>[],
        window = <double>[];
    for (var run = 0; run < _repeats; run++) {
      await _open(name);
      final session = _primary.session!;
      final candidates = await session.volumeCandidates();
      final watch = Stopwatch()..start();
      final volume = await session.buildVolume(
        0,
        candidates['revision'] as int,
      );
      build.add(watch.elapsedMicroseconds / 1000);
      if (volume['voxel_bytes'] != 314572800 ||
          await session.sampleVolume([179.2, 204.8, 180]) != 448) {
        throw StateError('Incorrect large-volume geometry');
      }
      final plane = <String, Object?>{
        'center': [179.2, 204.8, 180],
        'dimensions': [512, 512],
        'spacing_xy': [.7, .8],
        'orientation': {'kind': 'axial'},
        'slab': {'kind': 'single'},
      };
      Future<void> draw(
        Json p,
        List<double> results, [
        double level = 450,
      ]) async {
        watch.reset();
        final image = await session.reslice(
          p,
          window: {'center': level, 'width': 500},
        );
        results.add(watch.elapsedMicroseconds / 1000);
        if (image.pixels.length != 512 * 512 * 4) {
          throw StateError('Incomplete reslice');
        }
      }

      await draw(plane, axial);
      await draw({
        ...plane,
        'orientation': {'kind': 'coronal'},
      }, coronal);
      final oblique = {
        ...plane,
        'orientation': {
          'kind': 'oblique',
          'axes': [1, 0, 0, 0, math.sqrt1_2, math.sqrt1_2],
        },
        'slab': {'kind': 'maximum', 'thickness_mm': 4.8},
      };
      await draw(oblique, mip);
      for (var i = 1; i <= 5; i++) {
        await draw(oblique, window, 450.0 + i);
      }
      await draw({
        ...oblique,
        'center': [179.2, 205.5, 180],
      }, moved);
    }
    return {
      'build_ms': _metric(build),
      'axial_ms': _metric(axial),
      'coronal_ms': _metric(coronal),
      'mip_ms': _metric(mip),
      'moved_ms': _metric(moved),
      'window_ms': _metric(window),
      'stats': await _primary.session!.stats(),
    };
  }

  Future<Json> _indexed() async {
    const name = 'cine-350.dcm';
    final create = <double>[], fullOpen = <double>[];
    final displayed = List.generate(3, (_) => <double>[]);
    final bytesRead = <int>[];
    var manifestBytes = 0;
    for (var trial = 0; trial < _repeats; trial++) {
      await _closePanels();
      final watch = Stopwatch()..start();
      await _open(name);
      fullOpen.add(watch.elapsedMicroseconds / 1000);
      watch.reset();
      final manifest = await _primary.session!.createFrameIndex();
      create.add(watch.elapsedMicroseconds / 1000);
      manifestBytes = manifest.bytes.length;
      await _closePanels();
      watch.reset();
      await _open(name, index: manifest);
      final first = watch.elapsedMicroseconds / 1000;
      final session = _primary.session!;
      var total = 0;
      for (final (slot, frame) in [0, 175, 349].indexed) {
        watch.reset();
        if (frame != 0) await _primary.seek(frame, prefetch: false);
        displayed[slot].add(
          frame == 0 ? first : watch.elapsedMicroseconds / 1000,
        );
        final sample = await _primary.samplePresented(0, 0);
        final expected = [
          [32, 64, 63],
          [207, 77, 137],
          [189, 87, 75],
        ][slot];
        if (jsonEncode(sample['values']) != jsonEncode(expected)) {
          throw StateError('Incorrect indexed sample');
        }
        final stats = await session.stats();
        final read = (stats['session'] as Json)['source_read_bytes'] as int;
        if (trial == 0) bytesRead.add(read - total);
        total = read;
      }
    }
    return {
      'build_ms': _metric(create),
      'manifest_bytes': manifestBytes,
      'full_first_ms': _metric(fullOpen),
      'indexed_ms': displayed.map(_metric).toList(),
      'range_bytes': bytesRead,
      'stats': await _primary.session!.stats(),
    };
  }

  Future<Json> _soak() async {
    await _open('cine-350.dcm');
    if (_hidden) throw StateError('Cine must begin in the foreground');
    final started = _clock.elapsedMicroseconds;
    _soaking = true;
    _draws.clear();
    _timings.clear();
    setState(
      () => _status =
          'Cine soak · $_soakSeconds seconds · keep this screen awake',
    );
    final running = _primary.play();
    await Future<void>.delayed(const Duration(seconds: _soakSeconds));
    await _primary.settle();
    await running;
    _soaking = false;
    final ended = _clock.elapsedMicroseconds;
    if (_interrupted) throw StateError('Cine soak was interrupted');
    final window = math.min(60, _soakSeconds ~/ 2) * 1000000;
    Json segment(int from, int to) {
      final events = _draws
          .where((e) => e.time >= from && e.time < to)
          .toList();
      final engine = _timings
          .where((e) => e.time >= from && e.time < to)
          .toList();
      return {
        'shown': events.length,
        'interval_ms': _metric([
          for (var i = 1; i < events.length; i++)
            (events[i].time - events[i - 1].time) / 1000,
        ]),
        'build_ms': _metric(engine.map((e) => e.build / 1000).toList()),
        'raster_ms': _metric(engine.map((e) => e.raster / 1000).toList()),
      };
    }

    return {
      'seconds': (ended - started) / 1e6,
      'first_window': segment(started, started + window),
      'last_window': segment(ended - window, ended),
      'stats': await _primary.session!.stats(),
      'display': _primary.displayStats,
    };
  }

  Future<void> _closePanels() async {
    final sessions = _controllers.map((c) => c.session).nonNulls.toList();
    setState(() {
      _sources = [];
      _epoch++;
    });
    await Future.wait(sessions.map((s) => s.close()));
    await WidgetsBinding.instance.endOfFrame;
  }

  Future<Json> _startup(String name) async {
    const coldFixtures = ['benchmark-signed12.dcm', 'cine-350.dcm'];
    if (!coldFixtures.contains(name)) {
      throw StateError('Unknown startup fixture');
    }
    final directory = Platform.environment['RAYKIT_STARTUP_SOURCE_DIR'];
    if (directory == null) throw StateError('Set RAYKIT_STARTUP_SOURCE_DIR');
    _assets[name] = File('$directory/$name');
    final fixture = _manifest[name] as Json;
    final expected = fixture['expected'] as Json;
    final cine = name == 'cine-350.dcm';
    final probe = cine ? <Object?>[0, 0] : expected['sample'] as List;
    final before = ProcessInfo.currentRss;
    final opens = <Json>[];
    final seekMs = <double>[];
    final afterClose = <int>[];

    Future<void> verify(int index) async {
      final frame = _primary.presented!;
      if (frame.source['frame'] != index ||
          frame.source['content_sha256'] != fixture['sha256']) {
        throw StateError('Presented source or frame mismatch');
      }
      final sample = await _primary.samplePresented(
        probe[1] as int,
        probe[0] as int,
      );
      if (cine) {
        final reference =
            (expected['rgb_at_0_0'] as Json)['$index'] as List? ??
            [32 + index % 192, 64 + (index * 3) % 128, 64 + (index * 7) % 128];
        final actual = sample['values'] as List;
        for (var c = 0; c < 3; c++) {
          if (((reference[c] as int) - (actual[c] as int)).abs() >
              (expected['tolerance'] as int)) {
            throw StateError('Cine color differs from its reference');
          }
        }
      } else if (sample['stored'] != probe[2]) {
        throw StateError('Radiograph differs from its signed reference');
      }
    }

    for (var cycle = 0; cycle <= 10; cycle++) {
      final action = Stopwatch()..start();
      await _open(name);
      final first = action.elapsedMicroseconds;
      final session = _primary.session!;
      if (session.inspection.data['verification'] != 'full_source') {
        throw StateError('Startup requires full source verification');
      }
      await verify(0);
      final stats = await session.stats();
      final source = stats['session'] as Json;
      opens.add({
        'first_original_us': first,
        'renderer': _primary.presented!.renderer,
        'timing': {
          ...?stats['open_timing'] as Json?,
          'file_read_us': stats['full_source_file_read_us'],
          'hash_us': source['full_source_hash_us'],
          'parse_us': source['full_source_parse_us'],
          'frame_read_us': _primary.displayStats['frame_read_us'],
          'frame_draw_us': _primary.displayStats['frame_draw_us'],
        },
      });
      if (cine && cycle == 0) {
        for (final index in [
          175,
          349,
          for (var i = 0; i < 20; i++) (i * 53) % 350,
        ]) {
          final seek = Stopwatch()..start();
          await _primary.scrub(index);
          seekMs.add(seek.elapsedMicroseconds / 1000);
          await verify(index);
        }
      }
      await _closePanels();
      if (_primary.presented != null || !session.isClosed) {
        throw StateError('A closed source retained a frame or session');
      }
      await Future<void>.delayed(const Duration(milliseconds: 70));
      afterClose.add(ProcessInfo.currentRss);
    }
    return {
      'fixture': name,
      'opens': opens,
      'seek_ms': seekMs,
      'rss_before_bytes': before,
      'rss_after_close_bytes': afterClose,
    };
  }

  Future<void> _run() async {
    final before = ProcessInfo.currentRss;
    try {
      _folder = await Directory.systemTemp.createTemp('raykit-acceptance-');
      _manifest =
          jsonDecode(await rootBundle.loadString('assets/raykit/manifest.json'))
              as Json;
      _sampling = Timer.periodic(
        const Duration(milliseconds: 50),
        (_) => _rss.add(ProcessInfo.currentRss),
      );
      final startup = Platform.environment['RAYKIT_STARTUP_FIXTURE'];
      if (startup != null) {
        _results['startup'] = await _startup(startup);
        _results['rss'] = {'sampled_peak_bytes': _rss.reduce(math.max)};
        setState(() => _status = 'Startup verification complete');
        return;
      }
      _results['cpu'] = await _radiograph(RayKitDisplayMode.cpu);
      _results['shader'] = await _radiograph(RayKitDisplayMode.shader);
      _results['scrub'] = await _cine();
      _results['indexed'] = await _indexed();
      _results['ct'] = await _volume('large-enhanced-ct.dcm');
      _results['mr'] = await _volume('large-enhanced-mr.dcm');
      _results['soak'] = await _soak();
      await _open('cine-350.dcm', panels: 4);
      await Future.wait(
        _controllers.indexed.map((entry) => entry.$2.seek(349 - entry.$1 * 49)),
      );
      _results['four_panels'] = _controllers
          .map((c) => c.presented?.source['frame'])
          .toList();
      final closed = _primary.session!;
      await _closePanels();
      try {
        await closed.sample(0, 0, 0);
        throw StateError('Closed session still reads pixels');
      } on RayKitException catch (e) {
        if (e.code != 'closed') rethrow;
      }
      _results['rss'] = {
        'before_bytes': before,
        'sampled_peak_bytes': _rss.reduce(math.max),
        'after_closed_bytes': ProcessInfo.currentRss,
      };
      setState(
        () => _status = 'Acceptance complete · see RAYKIT_ACCEPTANCE output',
      );
    } catch (error) {
      _results['error'] = error.toString();
      if (mounted) setState(() => _status = 'Acceptance failed');
    } finally {
      _sampling?.cancel();
      _soaking = false;
      final report = jsonEncode({
        'commit': _commit,
        'device': _device,
        'os': Platform.operatingSystem,
        'os_version': Platform.operatingSystemVersion,
        'dart': Platform.version,
        'repeats': _repeats,
        'fixture_hashes': {
          for (final key in _assets.keys)
            key: (_manifest[key] as Json)['sha256'],
        },
        'observations': _results,
      });
      const limit = 1400;
      final sections = (report.length / limit).ceil();
      for (var part = 0; part < sections; part++) {
        final start = part * limit;
        debugPrintSynchronously(
          'RAYKIT_ACCEPTANCE ${part + 1}/$sections ${report.substring(start, math.min(start + limit, report.length))}',
        );
      }
    }
  }

  @override
  void dispose() {
    _sampling?.cancel();
    _lifecycle.dispose();
    SchedulerBinding.instance.removeTimingsCallback(_recordTiming);
    final folder = _folder;
    final sessions = _controllers.map((c) => c.session).nonNulls.toList();
    unawaited(() async {
      await Future.wait(sessions.map((s) => s.close()));
      await folder?.delete(recursive: true);
    }());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final count = _sources.length;
    final epoch = _epoch;
    Widget panel(int slot) => Expanded(
      child: RayKitViewer(
        source: _sources[slot],
        options: _options,
        displayMode: _display,
        controller: _controllers[slot],
        showControls: false,
        onPresented: (event) => _present(slot, epoch, event),
      ),
    );
    return Scaffold(
      appBar: AppBar(title: const Text('RayKit acceptance')),
      body: SafeArea(
        child: Column(
          children: [
            Text(_status),
            if (count == 1) panel(0),
            if (count == 4) ...[
              Expanded(child: Row(children: [panel(0), panel(1)])),
              Expanded(child: Row(children: [panel(2), panel(3)])),
            ],
          ],
        ),
      ),
    );
  }
}

Json _metric(List<double> input) {
  final values = [...input]..sort();
  final n = values.length;
  if (n == 0) return {'n': 0};
  return {
    'n': n,
    'median': (values[(n - 1) ~/ 2] + values[n ~/ 2]) / 2,
    'p95': values[(n * .95).ceil() - 1],
  };
}

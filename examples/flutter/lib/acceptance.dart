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
      _sources = List.generate(panels, (_) => RayKitSource.file(file));
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
      _results['cpu'] = await _radiograph(RayKitDisplayMode.cpu);
      _results['shader'] = await _radiograph(RayKitDisplayMode.shader);
      _results['scrub'] = await _cine();
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

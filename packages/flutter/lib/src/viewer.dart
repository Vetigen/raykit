import 'dart:async';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import 'session.dart';

class RayKitViewerController {
  RayKitViewerState? _viewer;
  RayKitSession? get session => _viewer?._session;
  List<Json> get measurements =>
      List.unmodifiable(_viewer?._measurements ?? []);

  Future<void> seek(int index) async {
    final viewer = _viewer;
    if (viewer == null) throw const RayKitException('closed');
    viewer._pause();
    await viewer._showFrame(index);
  }

  Future<Json> restoreMeasurement(Json measurement) async {
    final viewer = _viewer;
    if (viewer == null) throw const RayKitException('closed');
    return viewer._restore(measurement);
  }
}

class RayKitViewer extends StatefulWidget {
  const RayKitViewer({
    super.key,
    required this.source,
    this.options = const RayKitOpenOptions(),
    this.controller,
    this.onPresented,
    this.onMeasurement,
    this.onDocument,
  });
  final RayKitSource source;
  final RayKitOpenOptions options;
  final RayKitViewerController? controller;
  final ValueChanged<RayKitPresentedFrame>? onPresented;
  final ValueChanged<Json>? onMeasurement;
  final ValueChanged<RayKitSession>? onDocument;

  @override
  State<RayKitViewer> createState() => RayKitViewerState();
}

class RayKitPresentedFrame {
  const RayKitPresentedFrame({
    required this.source,
    required this.revision,
    required this.requestId,
    required this.view,
    required this.render,
  });
  final Json source;
  final String revision;
  final int requestId;
  final Json view;
  final Json render;
  String get quality => 'original';
}

enum _Tool {
  pan('Pan / zoom'),
  window('Window / level'),
  sample('Pixel value'),
  ruler('Ruler', 'raykit:length', ['Start', 'End']),
  angle('Angle', 'raykit:angle', ['Arm 1', 'Vertex', 'Arm 2']),
  vhs('VHS', 'raykit:canine-vhs', [
    'Long axis base',
    'Long axis apex',
    'Short axis start',
    'Short axis end',
    'Cranial T4',
    'Next cranial vertebral margin',
  ], 'lateral_thorax'),
  norberg('Norberg angle', 'raykit:norberg', [
    'Left femoral head center',
    'Right femoral head center',
    'Left cranial effective rim',
    'Right cranial effective rim',
  ], 'ventrodorsal_extended_hips'),
  tplo('TPLO', 'raykit:tplo', [
    'Cranial medial plateau',
    'Caudal medial plateau',
    'Proximal mechanical axis',
    'Distal mechanical axis',
    'Osteotomy center',
  ], 'mediolateral_stifle');

  const _Tool(
    this.label, [
    this.method,
    this.landmarks = const [],
    this.projection,
  ]);
  final String label;
  final String? method;
  final List<String> landmarks;
  final String? projection;
}

class RayKitViewerState extends State<RayKitViewer> {
  RayKitSession? _session;
  RayKitFrame? _frame;
  ui.Image? _image;
  _Transform? _transform;
  late final AppLifecycleListener _lifecycle;
  RayKitCancellation? _opening;
  RayKitCancellation? _seeking;
  RayKitCancellation? _painting;
  RayKitCancellation? _prefetching;
  Size _size = Size.zero;
  Offset _pan = Offset.zero;
  double _zoom = 1;
  int _rotation = 0;
  Json _render = {};
  bool _loading = true;
  bool _background = false;
  bool _playing = false;
  int _generation = 0;
  int _playGeneration = 0;
  int _resumeFrame = 0;
  double _rate = 1;
  String _status = '';
  String _value = '';
  String? _content;
  Future<void> _retired = Future.value();
  _Tool _tool = _Tool.pan;
  Offset? _lastFocal;
  double _initialZoom = 1;
  final List<Json> _measurements = [];
  final List<Offset> _draft = [];
  Json? _editing;
  bool _confirmProjection = false;
  final _target = TextEditingController();
  final _radius = TextEditingController();
  int _nextMeasurement = 0;

  @override
  void initState() {
    super.initState();
    widget.controller?._viewer = this;
    _lifecycle = AppLifecycleListener(
      onHide: _suspend,
      onPause: _suspend,
      onDetach: _suspend,
      onResume: _resume,
    );
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _run(_open());
    });
  }

  @override
  void didUpdateWidget(RayKitViewer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, widget.controller)) {
      oldWidget.controller?._viewer = null;
      widget.controller?._viewer = this;
    }
    if (!identical(oldWidget.source, widget.source) ||
        oldWidget.options != widget.options) {
      _resumeFrame = 0;
      _content = null;
      _run(_open());
    }
  }

  void _run(Future<void> operation) {
    unawaited(
      operation.catchError((Object error) {
        if (!mounted ||
            error is RayKitException &&
                ['closed', 'cancelled'].contains(error.code)) {
          return;
        }
        setState(() {
          _loading = false;
          _status = error is RayKitException
              ? error.toString()
              : 'Viewer operation failed.';
        });
      }),
    );
  }

  Future<void> _open() async {
    final retired = _retire();
    if (_background) {
      await retired;
      return;
    }
    final generation = _generation;
    final cancellation = _opening = RayKitCancellation();
    setState(() {
      _loading = true;
      _status = 'Opening source…';
    });
    await retired;
    cancellation.check();
    final session = await RayKitSession.open(
      widget.source,
      options: widget.options,
      cancellation: cancellation,
    );
    if (!mounted || generation != _generation) {
      await session.close();
      return;
    }
    _session = session;
    if (_content != session.inspection.contentSha256) {
      _measurements.clear();
      _draft.clear();
      _editing = null;
      _value = '';
      _pan = Offset.zero;
      _zoom = 1;
      _rotation = 0;
      _render = {};
      _resumeFrame = 0;
    }
    _content = session.inspection.contentSha256;
    final capabilities = session.inspection.capabilities;
    if (capabilities['frame_access'] == true) {
      await _showFrame(_resumeFrame.clamp(0, session.inspection.frames - 1));
    } else {
      setState(() {
        _loading = false;
        _status =
            capabilities['frame_limitation']?.toString() ??
            'Frame access unavailable.';
      });
      if (capabilities['host_document'] == true) {
        widget.onDocument?.call(session);
      }
    }
  }

  Future<void> _showFrame(int index, {bool prefetch = true}) async {
    final session = _session;
    if (session == null) throw const RayKitException('closed');
    _seeking?.cancel();
    _painting?.cancel();
    _prefetching?.cancel();
    final cancellation = _seeking = RayKitCancellation();
    final previous = _frame?.index ?? index;
    final frame = await session.readFrame(
      index,
      stored: false,
      cancellation: cancellation,
    );
    cancellation.check();
    if (!identical(session, _session)) throw const RayKitException('cancelled');
    final changed = _frame?.index != frame.index;
    _frame = frame;
    if (changed) {
      _draft.clear();
      _editing = null;
    }
    _resumeFrame = index;
    await _redraw(rebuildImage: true);
    cancellation.check();
    final neighbor = index + (index < previous ? -1 : 1);
    if (prefetch && neighbor >= 0 && neighbor < session.inspection.frames) {
      final token = _prefetching = RayKitCancellation();
      unawaited(
        session.prefetch(neighbor, cancellation: token).catchError((_) {}),
      );
    }
  }

  Json get _view => {
    'viewport': [_size.width, _size.height],
    'pan': [_pan.dx, _pan.dy],
    'zoom': _zoom,
    'quarter_turns': _rotation,
  };

  Future<void> _redraw({bool rebuildImage = false}) async {
    final session = _session;
    final frame = _frame;
    if (frame == null || session == null || _size.isEmpty || _background) {
      return;
    }
    _painting?.cancel();
    final token = _painting = RayKitCancellation();
    final view = _view;
    final settings = _render;
    final transform = await session.transform(
      frame.index,
      view,
      cancellation: token,
    );
    if (!mounted || token.isCancelled) return;
    ui.Image? image;
    if (rebuildImage ||
        _image == null ||
        _transform?.requestId != frame.requestId) {
      final pixels = settings.isEmpty
          ? frame.pixels
          : await session.render(frame.index, settings, cancellation: token);
      if (token.isCancelled) return;
      image = await _decode(pixels, frame.columns, frame.rows);
    }
    if (!mounted || token.isCancelled) {
      image?.dispose();
      return;
    }
    final old = image != null ? _image : null;
    setState(() {
      if (image != null) _image = image;
      _transform = _Transform.fromJson(
        transform['transform'] as Json,
        frame.requestId,
      );
      _loading = false;
      final geometry = frame.geometry;
      final directions =
          geometry['increasing_column'] is List &&
          geometry['increasing_row'] is List;
      final calibrated = (geometry['calibration'] as Json)['kind'] != 'none';
      _status =
          'Original · ${frame.columns} × ${frame.rows}${directions ? '' : ' · Orientation unavailable'}${calibrated ? '' : ' · Physical calibration unavailable'}';
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      old?.dispose();
      if (!mounted ||
          token.isCancelled ||
          session != _session ||
          frame != _frame) {
        return;
      }
      widget.onPresented?.call(
        RayKitPresentedFrame(
          source: frame.source,
          revision: session.revision,
          requestId: frame.requestId,
          view: view,
          render: settings,
        ),
      );
    });
  }

  Future<Offset?> _pixel(Offset screen) async {
    final frame = _frame;
    final session = _session;
    if (frame == null ||
        session == null ||
        _transform?.requestId != frame.requestId) {
      return null;
    }
    final mapped = await session.transform(
      frame.index,
      _view,
      screenPoint: {'x': screen.dx, 'y': screen.dy},
    );
    if (!mounted || frame != _frame || session != _session) return null;
    final value = _readPoint(mapped['pixel'] as Json);
    return value.dx >= -0.5 &&
            value.dy >= -0.5 &&
            value.dx < frame.columns - 0.5 &&
            value.dy < frame.rows - 0.5
        ? value
        : null;
  }

  Future<void> _tap(Offset screen) async {
    if (_tool.method == null && _tool != _Tool.sample) return;
    final session = _session;
    final frame = _frame;
    if (session == null || frame == null) return;
    final pixel = await _pixel(screen);
    if (pixel == null || !mounted || frame != _frame) return;
    if (_tool == _Tool.sample) {
      final sample = await session.sample(
        frame.index,
        pixel.dx.round(),
        pixel.dy.round(),
      );
      if (mounted && session == _session && frame == _frame) {
        setState(
          () => _value = sample['kind'] == 'monochrome'
              ? 'Stored ${sample['stored']}, modality ${sample['modality']}'
              : '${sample['space']} ${sample['values']}',
        );
      }
    } else {
      setState(() => _draft.add(pixel));
    }
  }

  Future<void> _calculate() async {
    final tool = _tool;
    final session = _session;
    final frame = _frame;
    if (tool.method == null || session == null || frame == null) return;
    Json? parameters;
    if (_editing != null) {
      parameters = (_editing!['input'] as Json)['parameters'] as Json?;
    } else if (tool.projection != null) {
      if (!_confirmProjection) {
        throw const RayKitException(
          'geometry',
          'Confirm the radiographic projection',
        );
      }
      parameters = {'projection': tool.projection};
      if (tool == _Tool.tplo) {
        parameters['target_deg'] = double.tryParse(_target.text);
        parameters['radius_mm'] = double.tryParse(_radius.text);
      }
    }
    final existing = (_editing?['input'] as Json?)?['id'];
    final id =
        existing ??
        '${DateTime.now().microsecondsSinceEpoch}-${_nextMeasurement++}';
    final record = await session.measure(frame.index, {
      'id': id,
      'method': tool.method,
      'version': 1,
      'points': _draft.map((p) => {'x': p.dx, 'y': p.dy}).toList(),
      'parameters': parameters,
    });
    if (!mounted || session != _session || frame != _frame) return;
    _store(record);
  }

  Future<Json> _restore(Json measurement) async {
    final session = _session;
    if (session == null) throw const RayKitException('closed');
    final record = await session.reopenMeasurement(measurement);
    if (session != _session) throw const RayKitException('cancelled');
    _pause();
    await _showFrame((record['source'] as Json)['frame'] as int);
    if (!mounted || session != _session) {
      throw const RayKitException('cancelled');
    }
    _store(record);
    return record;
  }

  void _store(Json record) {
    setState(() {
      final id = (record['input'] as Json)['id'];
      _measurements.removeWhere((r) => (r['input'] as Json)['id'] == id);
      _measurements.add(record);
      _draft.clear();
      _editing = null;
      _value = (record['values'] as List)
          .cast<Json>()
          .map(
            (v) =>
                '${v['name']} ${(v['value'] as num).toStringAsFixed(2)} ${v['unit']}',
          )
          .join(' · ');
    });
    widget.onMeasurement?.call(record);
  }

  void _scale(ScaleUpdateDetails details) {
    final last = _lastFocal;
    final focal = details.localFocalPoint;
    _lastFocal = focal;
    if (last == null) return;
    if (_tool == _Tool.pan) {
      _zoom = (_initialZoom * details.scale).clamp(0.01, 128.0);
      _pan += focal - last;
      _run(_redraw());
    } else if (_tool == _Tool.window) {
      final display = _frame?.display;
      if (display == null) return;
      final voi = display['voi'] as Json;
      final window =
          (_render['window'] ?? voi['window'] ?? display['automatic_window'])
              as Json;
      final width = (window['width'] as num).toDouble();
      final center = (window['center'] as num).toDouble();
      final delta = focal - last;
      _render = {
        ..._render,
        'window': {
          ...window,
          'center': center + delta.dy * width / 220,
          'width': (width + delta.dx * width / 220).clamp(1.0, 1e30),
        },
      };
      _run(_redraw(rebuildImage: true));
    }
  }

  void _beginEdit(Offset screen) {
    final transform = _transform;
    final index = _frame?.index;
    if (transform == null || index == null || _tool.method == null) return;
    for (final record in _measurements.reversed) {
      final input = record['input'] as Json;
      if ((record['source'] as Json)['frame'] != index ||
          input['method'] != _tool.method) {
        continue;
      }
      final points = (input['points'] as List)
          .cast<Json>()
          .map(_readPoint)
          .toList();
      final point = points.indexWhere(
        (p) => (transform.project(p) - screen).distance <= 20,
      );
      if (point < 0) continue;
      setState(() {
        _editing = record;
        _draft
          ..clear()
          ..addAll(points)
          ..removeAt(point);
      });
      _run(_replaceLandmark(point));
      return;
    }
  }

  Future<void> _replaceLandmark(int index) async {
    final point = await showDialog<Offset>(
      context: context,
      builder: (dialogContext) {
        final source =
            ((_editing!['input'] as Json)['points'] as List)[index] as Json;
        var x = (source['x'] as num).toDouble(),
            y = (source['y'] as num).toDouble();
        return AlertDialog(
          title: const Text('Edit landmark'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextFormField(
                initialValue: '$x',
                decoration: const InputDecoration(labelText: 'Source X'),
                keyboardType: TextInputType.number,
                onChanged: (s) => x = double.tryParse(s) ?? double.nan,
              ),
              TextFormField(
                initialValue: '$y',
                decoration: const InputDecoration(labelText: 'Source Y'),
                keyboardType: TextInputType.number,
                onChanged: (s) => y = double.tryParse(s) ?? double.nan,
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext),
              child: const Text('Cancel'),
            ),
            TextButton(
              onPressed: () {
                if (x.isFinite && y.isFinite) {
                  Navigator.pop(dialogContext, Offset(x, y));
                }
              },
              child: const Text('Apply'),
            ),
          ],
        );
      },
    );
    if (!mounted || _editing == null) return;
    if (point == null) {
      setState(() {
        _editing = null;
        _draft.clear();
      });
      return;
    }
    _draft.insert(index, point);
    await _calculate();
  }

  Future<void> _play() async {
    final session = _session;
    final count = session?.inspection.frames ?? 0;
    if (session == null || count < 2) return;
    if (_playing) {
      _pause();
      setState(() {});
      return;
    }
    final generation = ++_playGeneration;
    setState(() => _playing = true);
    final durations = session.inspection.frameDurations;
    try {
      while (mounted &&
          _playing &&
          generation == _playGeneration &&
          session == _session) {
        final index = _frame?.index ?? 0;
        final ms = (durations?[index] ?? 1000 / 15) / _rate;
        await Future<void>.delayed(Duration(microseconds: (ms * 1000).round()));
        if (generation != _playGeneration || session != _session) return;
        await _showFrame((index + 1) % count);
      }
    } finally {
      if (mounted && generation == _playGeneration) {
        setState(() => _playing = false);
      }
    }
  }

  void _pause() {
    _playing = false;
    _playGeneration++;
  }

  Future<void> _retire() async {
    _generation++;
    _pause();
    _opening?.cancel();
    _seeking?.cancel();
    _painting?.cancel();
    _prefetching?.cancel();
    final session = _session;
    final image = _image;
    _session = null;
    _frame = null;
    _image = null;
    _transform = null;
    if (image != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) => image.dispose());
    }
    final current = session?.close();
    if (current != null) {
      _retired = Future.wait<void>([_retired, current]);
    }
    await _retired;
  }

  void _suspend() {
    if (_background) return;
    _background = true;
    _run(_retire());
    if (mounted) setState(() {});
  }

  void _resume() {
    if (!_background) return;
    _background = false;
    _run(_open());
  }

  @override
  void dispose() {
    widget.controller?._viewer = null;
    _lifecycle.dispose();
    _target.dispose();
    _radius.dispose();
    _image?.dispose();
    _image = null;
    unawaited(_retire());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final frame = _frame;
    final count = _session?.inspection.frames ?? 0;
    final image = _image;
    final transform = _transform;
    final colorScheme = Theme.of(context).colorScheme;
    final pointLabel = _tool.landmarks.isEmpty
        ? ''
        : _tool.landmarks[_draft.length.clamp(0, _tool.landmarks.length - 1)];
    return Column(
      children: [
        Wrap(
          spacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            DropdownButton<_Tool>(
              value: _tool,
              items: _Tool.values
                  .map(
                    (tool) =>
                        DropdownMenuItem(value: tool, child: Text(tool.label)),
                  )
                  .toList(),
              onChanged: (tool) {
                if (tool != null) {
                  setState(() {
                    _tool = tool;
                    _confirmProjection = false;
                    _draft.clear();
                    _editing = null;
                  });
                }
              },
            ),
            IconButton(
              tooltip: 'Rotate',
              onPressed: frame == null
                  ? null
                  : () {
                      _rotation = (_rotation + 1) % 4;
                      _run(_redraw());
                    },
              icon: const Icon(Icons.rotate_right),
            ),
            TextButton(
              onPressed: frame == null
                  ? null
                  : () {
                      _render = {
                        ..._render,
                        'invert': _render['invert'] != true,
                      };
                      _run(_redraw(rebuildImage: true));
                    },
              child: const Text('Invert'),
            ),
            TextButton(
              onPressed: frame == null
                  ? null
                  : () {
                      _pan = Offset.zero;
                      _zoom = 1;
                      _rotation = 0;
                      _render = {};
                      _run(_redraw(rebuildImage: true));
                    },
              child: const Text('Reset'),
            ),
            if (_tool.method != null) ...[
              TextButton(
                onPressed: _draft.isEmpty
                    ? null
                    : () => setState(() => _draft.removeLast()),
                child: const Text('Undo point'),
              ),
              TextButton(
                onPressed: _draft.isEmpty ? null : () => _run(_calculate()),
                child: const Text('Calculate'),
              ),
            ],
          ],
        ),
        if (_tool.method != null) Text(pointLabel),
        if (_tool.projection case final projection?)
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Checkbox(
                value: _confirmProjection,
                onChanged: (value) =>
                    setState(() => _confirmProjection = value ?? false),
              ),
              Flexible(
                child: Text('Confirm ${projection.replaceAll('_', ' ')}'),
              ),
            ],
          ),
        if (_tool == _Tool.tplo)
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _target,
                  keyboardType: const TextInputType.numberWithOptions(
                    signed: true,
                    decimal: true,
                  ),
                  decoration: const InputDecoration(
                    labelText: 'Target angle (°)',
                  ),
                ),
              ),
              Expanded(
                child: TextField(
                  controller: _radius,
                  keyboardType: const TextInputType.numberWithOptions(
                    decimal: true,
                  ),
                  decoration: const InputDecoration(labelText: 'Radius (mm)'),
                ),
              ),
            ],
          ),
        Expanded(
          child: LayoutBuilder(
            builder: (context, constraints) {
              final size = constraints.biggest;
              if (_size != size) {
                _size = size;
                WidgetsBinding.instance.addPostFrameCallback((_) {
                  if (mounted) _run(_redraw());
                });
              }
              return GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTapUp: (details) => _run(_tap(details.localPosition)),
                onLongPressStart: (details) =>
                    _beginEdit(details.localPosition),
                onScaleStart: (details) {
                  _lastFocal = details.localFocalPoint;
                  _initialZoom = _zoom;
                },
                onScaleUpdate: _scale,
                onScaleEnd: (_) => _lastFocal = null,
                child: CustomPaint(
                  size: size,
                  painter: _Painter(
                    image,
                    transform,
                    colorScheme.tertiary,
                    _paths(frame),
                    List.of(_draft),
                  ),
                ),
              );
            },
          ),
        ),
        if (_loading) const LinearProgressIndicator(),
        if (count > 1)
          Row(
            children: [
              IconButton(
                tooltip: _playing ? 'Pause' : 'Play',
                onPressed: () => _run(_play()),
                icon: Icon(_playing ? Icons.pause : Icons.play_arrow),
              ),
              Expanded(
                child: Slider(
                  label: 'Frame ${(frame?.index ?? 0) + 1} of $count',
                  min: 0,
                  max: (count - 1).toDouble(),
                  value: (frame?.index ?? 0).toDouble(),
                  divisions: count - 1,
                  onChanged: (v) {
                    _pause();
                    _run(_showFrame(v.round()));
                  },
                ),
              ),
              Text('${(frame?.index ?? 0) + 1} / $count'),
              DropdownButton<double>(
                value: _rate,
                items: [0.5, 1.0, 2.0]
                    .map((r) => DropdownMenuItem(value: r, child: Text('$r×')))
                    .toList(),
                onChanged: (value) => setState(() => _rate = value ?? 1),
              ),
            ],
          ),
        Text(_status, textAlign: TextAlign.center),
        if (_value.isNotEmpty) Text(_value, textAlign: TextAlign.center),
      ],
    );
  }

  List<List<Offset>> _paths(RayKitFrame? frame) => _measurements
      .where(
        (r) => (r['source'] as Json)['frame'] == frame?.index && r != _editing,
      )
      .expand((r) {
        final input = r['input'] as Json;
        final points = (input['points'] as List)
            .cast<Json>()
            .map(_readPoint)
            .toList();
        return switch (input['method']) {
          'raykit:norberg' => [
            [points[0], points[1]],
            [points[0], points[2]],
            [points[1], points[3]],
          ],
          'raykit:canine-vhs' => [
            points.sublist(0, 2),
            points.sublist(2, 4),
            points.sublist(4),
          ],
          'raykit:tplo' => [
            points.sublist(0, 2),
            points.sublist(2, 4),
            points.sublist(4),
          ],
          _ => [points],
        };
      })
      .toList();
}

Offset _readPoint(Json point) =>
    Offset((point['x'] as num).toDouble(), (point['y'] as num).toDouble());
Offset _readPair(List pair) =>
    Offset((pair[0] as num).toDouble(), (pair[1] as num).toDouble());

class _Transform {
  const _Transform(this.origin, this.x, this.y, this.requestId);
  factory _Transform.fromJson(Json json, int requestId) => _Transform(
    _readPoint(json['origin'] as Json),
    _readPair(json['x_axis'] as List),
    _readPair(json['y_axis'] as List),
    requestId,
  );
  final Offset origin;
  final Offset x;
  final Offset y;
  final int requestId;
  Offset project(Offset point) => origin + x * point.dx + y * point.dy;
}

class _Painter extends CustomPainter {
  const _Painter(
    this.image,
    this.transform,
    this.accent,
    this.paths,
    this.draft,
  );
  final ui.Image? image;
  final _Transform? transform;
  final Color accent;
  final List<List<Offset>> paths;
  final List<Offset> draft;
  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = Colors.black);
    final raw = image;
    final view = transform;
    if (raw == null || view == null) return;
    canvas.save();
    canvas.clipRect(Offset.zero & size);
    canvas.save();
    canvas.transform(
      Float64List.fromList([
        view.x.dx,
        view.x.dy,
        0,
        0,
        view.y.dx,
        view.y.dy,
        0,
        0,
        0,
        0,
        1,
        0,
        view.origin.dx,
        view.origin.dy,
        0,
        1,
      ]),
    );
    canvas.drawImage(
      raw,
      const Offset(-0.5, -0.5),
      Paint()..filterQuality = FilterQuality.none,
    );
    canvas.restore();
    for (final path in [...paths, draft]) {
      final paint = Paint()
        ..color = identical(path, draft) ? Colors.amber : accent;
      Offset? previous;
      for (final source in path) {
        final p = view.project(source);
        if (previous != null) {
          canvas.drawLine(previous, p, paint..strokeWidth = 2);
        }
        canvas.drawCircle(p, 3.5, paint);
        previous = p;
      }
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_Painter oldDelegate) =>
      image != oldDelegate.image ||
      transform != oldDelegate.transform ||
      paths != oldDelegate.paths ||
      draft != oldDelegate.draft;
}

Future<ui.Image> _decode(Uint8List rgba, int width, int height) async {
  final buffer = await ui.ImmutableBuffer.fromUint8List(rgba);
  try {
    final descriptor = ui.ImageDescriptor.raw(
      buffer,
      width: width,
      height: height,
      pixelFormat: ui.PixelFormat.rgba8888,
    );
    try {
      final codec = await descriptor.instantiateCodec();
      try {
        return (await codec.getNextFrame()).image;
      } finally {
        codec.dispose();
      }
    } finally {
      descriptor.dispose();
    }
  } finally {
    buffer.dispose();
  }
}

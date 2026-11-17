import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';

import 'display.dart';
import 'session.dart';

class RayKitViewerController {
  RayKitViewerState? _viewer;
  RayKitSession? get session => _viewer?._session;
  RayKitPresentedFrame? get presented => _viewer?._presented;
  List<Json> get measurements {
    final viewer = _viewer;
    if (viewer == null || viewer._session?.isClosed != false) return const [];
    return List.unmodifiable(
      viewer._measurements.map(
        (record) => jsonDecode(jsonEncode(record)) as Json,
      ),
    );
  }

  Json get displayStats => _viewer?._displayStats ?? const {};

  RayKitViewerState get _attached =>
      _viewer ?? (throw const RayKitException('closed'));

  void _detach(RayKitViewerState viewer) {
    if (identical(_viewer, viewer)) _viewer = null;
  }

  Future<void> seek(int index, {bool prefetch = true}) async {
    final viewer = _attached;
    viewer._pause();
    await viewer._showFrame(index, prefetch: prefetch);
  }

  Future<void> scrub(int index) async {
    final viewer = _attached;
    viewer._pause();
    await viewer._showFrame(index, continuous: true);
  }

  Future<void> settle() async => _attached._settle();

  Future<void> play({double? rate}) async {
    final viewer = _attached;
    if (rate != null) {
      if (!rate.isFinite || rate < 0.1 || rate > 8) {
        throw const RayKitException('invalid_request', 'Cine playback rate');
      }
    }
    await viewer._play(rate);
  }

  Future<void> setRenderOptions(Json options) async {
    final viewer = _attached;
    viewer._render = {
      ...options,
      if (options['window'] case final Json window) 'window': Map.of(window),
      if (options['voi'] case final Json voi) 'voi': Map.of(voi),
    };
    viewer._preset = null;
    await viewer._redraw();
  }

  Future<void> setView({
    Offset pan = Offset.zero,
    double zoom = 1,
    int quarterTurns = 0,
  }) async {
    if (!zoom.isFinite || !pan.isFinite) {
      throw const RayKitException('invalid_request', 'View transform');
    }
    final viewer = _attached;
    viewer._pan = pan;
    viewer._zoom = zoom.clamp(0.01, 128.0);
    viewer._rotation = quarterTurns % 4;
    await viewer._redraw();
  }

  Offset? mapPoint(Offset screen) => _attached._pixel(screen);

  Future<Json> pointAt(Offset pixel) => _attached._sample(pixel);

  Future<void> setSegmentation(Json metadata, Uint8List mask) =>
      _attached._setSegmentation(metadata, mask);

  Future<Json> samplePresented(int x, int y) async {
    final viewer = _attached;
    final session = viewer._session;
    final frame = viewer._presented;
    if (session == null || frame == null) throw const RayKitException('closed');
    final sample = await session.sample(frame.source['frame'] as int, x, y);
    if (frame.requestId != viewer._presented?.requestId ||
        !identical(session, viewer._session)) {
      throw const RayKitException('cancelled');
    }
    return sample;
  }

  Future<Json> restoreMeasurement(Json measurement) async {
    final viewer = _viewer;
    if (viewer == null) throw const RayKitException('closed');
    return viewer._restore(measurement);
  }
}

/// The shader path requires a successful precision probe. Automatic selection uses
/// the CPU reference until device performance has been established by the host.
enum RayKitDisplayMode { auto, cpu, shader }

class RayKitViewer extends StatefulWidget {
  const RayKitViewer({
    super.key,
    required this.source,
    this.options = const RayKitOpenOptions(),
    this.controller,
    this.showControls = true,
    this.displayMode = RayKitDisplayMode.auto,
    this.onPresented,
    this.onMeasurement,
    this.onDocument,
    this.onSeek,
    this.onViewChange,
    this.onSamplePoint,
    this.initialRender = const {},
    this.initialFrame = 0,
    this.onReviewStart,
  });
  final RayKitSource source;
  final RayKitOpenOptions options;
  final RayKitViewerController? controller;
  final bool showControls;
  final RayKitDisplayMode displayMode;
  final ValueChanged<RayKitPresentedFrame>? onPresented;
  final ValueChanged<Json>? onMeasurement;
  final ValueChanged<RayKitSession>? onDocument;
  final Future<void> Function(int index, bool continuous)? onSeek;
  final ValueChanged<Json>? onViewChange;
  final void Function(RayKitPresentedFrame frame, Offset pixel)? onSamplePoint;
  final Json initialRender;
  final int initialFrame;
  final VoidCallback? onReviewStart;

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
    this.renderer = 'cpu',
  });
  final Json source;
  final String revision;
  final int requestId;
  final Json view;
  final Json render;
  final String renderer;
  String get quality => 'original';
}

/// Applies the v1 RayKit shared-view envelope after the host authorizes it.
class RayKitSharedView {
  RayKitSharedView(this.controller, this.origin, this.canAccess);
  final RayKitViewerController controller;
  final String origin;
  final Future<bool> Function(Json event) canAccess;
  final _received = <String, int>{};
  final _inFlight = <String, int>{};
  int _sequence = 0;
  int _generation = 0;
  bool _closed = false;
  bool _applying = false;

  Json? outgoing(RayKitPresentedFrame frame) {
    if (_closed || _applying || origin.isEmpty || origin.length > 128) {
      return null;
    }
    return {
      'version': 1,
      'origin': origin,
      'sequence': ++_sequence,
      'source': Map.of(frame.source),
      'revision': frame.revision,
      'view': Map.of(frame.view)..remove('viewport'),
      'render': Map.of(frame.render),
    };
  }

  Future<bool> apply(Json incoming) async {
    Json event;
    try {
      final encoded = jsonEncode(incoming);
      if (encoded.length > 128 * 1024) return false;
      event = jsonDecode(encoded) as Json;
    } on JsonUnsupportedObjectError {
      return false;
    }
    final viewer = controller._viewer;
    final session = viewer?._session;
    final source = event['source'];
    final view = event['view'];
    final render = event['render'];
    final sender = event['origin'];
    final sequence = event['sequence'];
    if (_closed ||
        viewer == null ||
        session == null ||
        event['version'] != 1 ||
        source is! Json ||
        view is! Json ||
        render is! Json ||
        sender is! String ||
        sender.isEmpty ||
        sender.length > 128 ||
        sender == origin ||
        sequence is! int ||
        sequence <= (_received[sender] ?? 0) ||
        sequence <= (_inFlight[sender] ?? 0) ||
        !(_received.containsKey(sender) ||
            _received.length + _inFlight.length < 64) ||
        event['revision'] != session.revision ||
        source['instance_uid'] != session.inspection.instanceUid ||
        source['sop_class_uid'] != session.inspection.data['sop_class_uid'] ||
        source['content_sha256'] != session.inspection.contentSha256) {
      return false;
    }
    final index = source['frame'];
    final zoom = view['zoom'];
    final rotation = view['quarter_turns'];
    final pan = view['pan'];
    if (index is! int ||
        index < 0 ||
        index >= session.inspection.frames ||
        zoom is! num ||
        !zoom.isFinite ||
        zoom < .01 ||
        zoom > 128 ||
        rotation is! int ||
        rotation < 0 ||
        rotation > 3 ||
        pan is! List ||
        pan.length != 2 ||
        pan.any((value) => value is! num || !value.isFinite)) {
      return false;
    }
    final generation = ++_generation;
    _inFlight[sender] = sequence;
    try {
      if (!await canAccess(event) ||
          _closed ||
          generation != _generation ||
          viewer != controller._viewer ||
          session != viewer._session) {
        return false;
      }
      final info = await session.frameInfo(index);
      if ((info['source'] as Json)['frame_of_reference_uid'] !=
              source['frame_of_reference_uid'] ||
          _closed ||
          generation != _generation ||
          session != viewer._session) {
        return false;
      }
      _applying = true;
      viewer._pause();
      viewer._pan = _readPair(pan);
      viewer._zoom = zoom.toDouble();
      viewer._rotation = rotation;
      viewer._preset = null;
      viewer._render = {
        ...render,
        for (final key in ['window', 'voi'])
          if (render[key] case final Json value) key: Map.of(value),
      };
      await viewer._showFrame(index, prefetch: false);
      if (_closed ||
          generation != _generation ||
          session != viewer._session ||
          viewer._presented?.source['frame'] != index) {
        return false;
      }
      _received[sender] = sequence;
      return true;
    } finally {
      if (_inFlight[sender] == sequence) _inFlight.remove(sender);
      if (generation == _generation) _applying = false;
    }
  }

  void close() {
    _closed = true;
    _generation++;
  }
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

const _presets = {
  'soft': (label: 'RayKit soft tissue', center: 40, width: 400),
  'bone': (label: 'RayKit bone', center: 500, width: 2000),
  'lung': (label: 'RayKit lung', center: -600, width: 1500),
};

class RayKitViewerState extends State<RayKitViewer> {
  RayKitSession? _session;
  StreamSubscription<void>? _revoked;
  Future<void> Function()? _releaseSession;
  Future<void> Function()? _suspendedLease;
  RayKitFrame? _frame;
  FrameRaster? _image;
  MonochromeShader? _shader;
  List<double>? _uniforms;
  Json? _drawnRender;
  _Transform? _transform;
  _Transform? _presentedTransform;
  RayKitPresentedFrame? _presented;
  (Size, Offset, double, int, int, int, double, double)? _mapping;
  ({int index, Completer<void> done})? _pendingSeek;
  int? _targetFrame;
  double? _sliderTarget;
  bool _redrawQueued = false;
  int _preparedImages = 0;
  int _uploadedBytes = 0;
  int _imagePaints = 0;
  int _presentations = 0;
  int? _frameReadUs;
  int? _frameDrawUs;
  int _cineSkipped = 0;
  int _cineShown = 0;
  int? _editIndex;
  bool _movedLandmark = false;
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
  String? _preset;
  ({int frame, Offset pixel})? _pointer;
  ({int frame, FrameRaster raster})? _segmentation;
  final _hiddenLayers = <String>{};
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

  Json get _displayStats => {
    'prepared_images': _preparedImages,
    'image_upload_bytes': _uploadedBytes,
    'image_paints': _imagePaints,
    'presentations': _presentations,
    'frame_read_us': _frameReadUs,
    'frame_draw_us': _frameDrawUs,
    'cine_shown': _cineShown,
    'cine_skipped': _cineSkipped,
    'image_bytes_estimate': _image?.bytes ?? 0,
    'shader_texture_bytes_estimate': _image?.texture == true
        ? _image!.bytes
        : 0,
  };

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
      oldWidget.controller?._detach(this);
      widget.controller?._viewer = this;
    }
    if (!identical(oldWidget.source, widget.source) ||
        oldWidget.options != widget.options ||
        oldWidget.displayMode != widget.displayMode) {
      _resumeFrame = widget.initialFrame;
      _content = null;
      _clearSourceReview();
      if (!identical(oldWidget.source, widget.source)) {
        unawaited(_suspendedLease?.call());
        _suspendedLease = null;
      }
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
    final shaderFuture = widget.displayMode == RayKitDisplayMode.shader
        ? MonochromeShader.available()
        : null;
    final attached = widget.source.attachedSession;
    if (attached?.isClosed == true) {
      _clearSourceReview();
      setState(() {
        _loading = false;
        _status = 'Source closed.';
      });
      return;
    }
    final session =
        attached ??
        await RayKitSession.open(
          widget.source,
          options: widget.options,
          cancellation: cancellation,
        );
    final release = attached != null ? session.retain() : session.close;
    final shader = await shaderFuture;
    if (!mounted || generation != _generation || session.isClosed) {
      await release();
      return;
    }
    _session = session;
    _releaseSession = release;
    _revoked = session.revocations.listen((_) {
      if (!mounted || !identical(_session, session)) return;
      _run(_retire());
      setState(() {
        _clearSourceReview();
        _loading = false;
        _status = 'Source closed.';
      });
    });
    _shader = shader;
    if (_content != session.inspection.contentSha256) {
      _clearSourceReview();
      _pan = Offset.zero;
      _zoom = 1;
      _rotation = 0;
      _render = Map.of(widget.initialRender);
      _preset = null;
      _resumeFrame = widget.initialFrame;
    }
    _content = session.inspection.contentSha256;
    final capabilities = session.inspection.capabilities;
    if (capabilities['frame_access'] == true) {
      await _showFrame(
        _resumeFrame.clamp(0, session.inspection.frames - 1),
        prefetch:
            attached == null &&
            session.inspection.data['verification'] != 'pinned_frame_index',
      );
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

  void _clearSourceReview() {
    _measurements.clear();
    _draft.clear();
    _editing = null;
    _value = '';
    _pointer = null;
  }

  Future<void> _navigate(int index, {bool continuous = false}) {
    _pause();
    return widget.onSeek?.call(index, continuous) ??
        _showFrame(
          index,
          prefetch: widget.source.attachedSession == null,
          continuous: continuous,
        );
  }

  Future<void> _showFrame(
    int index, {
    bool prefetch = true,
    bool continuous = false,
  }) async {
    final session = _session;
    if (session == null) throw const RayKitException('closed');
    if (index < 0 || index >= session.inspection.frames) {
      throw const RayKitException('invalid_request', 'Frame index');
    }
    _targetFrame = index;
    _cancelPendingSeek();
    _prefetching?.cancel();
    if (continuous) {
      final done = Completer<void>();
      _pendingSeek = (index: index, done: done);
      _drainSeek();
      return done.future;
    }
    return _prepareFrame(index, prefetch: prefetch);
  }

  void _cancelPendingSeek() {
    _pendingSeek?.done.completeError(const RayKitException('cancelled'));
    _pendingSeek = null;
  }

  void _drainSeek() {
    final next = _pendingSeek;
    if (_seeking != null || next == null) return;
    _pendingSeek = null;
    unawaited(
      _prepareFrame(
        next.index,
        prefetch: false,
      ).then(next.done.complete, onError: next.done.completeError),
    );
  }

  Future<void> _prepareFrame(int index, {required bool prefetch}) async {
    final session = _session;
    if (session == null) throw const RayKitException('closed');
    _seeking?.cancel();
    _painting?.cancel();
    final cancellation = _seeking = RayKitCancellation();
    FrameRaster? prepared;
    try {
      final previous = _frame?.index ?? index;
      final settings = _render;
      if (_presented?.source['frame'] == index &&
          _frame?.index == index &&
          identical(_drawnRender, settings)) {
        return;
      }
      final read = Stopwatch()..start();
      final frame = await session.readFrame(
        index,
        stored: false,
        render: settings,
        texture16: _shader != null,
        fallbackVoi: true,
        cancellation: cancellation,
      );
      final readUs = read.elapsedMicroseconds;
      cancellation.check();
      final draw = Stopwatch()..start();
      final applied = _appliedRender(frame, settings);
      final uniforms = frame.encoding == 'mono_u16_rg'
          ? MonochromeShader.uniforms(frame, applied)
          : null;
      final pixels = frame.encoding == 'mono_u16_rg' && uniforms == null
          ? await session.render(index, applied, cancellation: cancellation)
          : frame.pixels;
      cancellation.check();
      prepared = await _rasterize(pixels, frame, texture: uniforms != null);
      cancellation.check();
      final metadata = RayKitFrame(frame.data, Uint8List(0), frame.requestId);
      await _present(
        session,
        metadata,
        prepared,
        uniforms,
        settings,
        cancellation,
        timing: (readUs: readUs, draw: draw),
      );
      cancellation.check();
      final neighbor = index + (index < previous ? -1 : 1);
      if (prefetch &&
          _pendingSeek == null &&
          neighbor >= 0 &&
          neighbor < session.inspection.frames &&
          widget.source.attachedSession == null) {
        final token = _prefetching = RayKitCancellation();
        unawaited(
          session.prefetch(neighbor, cancellation: token).catchError((_) {}),
        );
      }
    } finally {
      if (!identical(_image, prepared)) prepared?.dispose();
      if (identical(_seeking, cancellation)) {
        _seeking = null;
        _drainSeek();
        if (_seeking == null && _redrawQueued) {
          _redrawQueued = false;
          _run(_redraw());
        }
      }
    }
  }

  Json get _view => {
    'viewport': [_size.width, _size.height],
    'pan': [_pan.dx, _pan.dy],
    'zoom': _zoom,
    'quarter_turns': _rotation,
  };

  Future<FrameRaster> _rasterize(
    Uint8List pixels,
    RayKitFrame frame, {
    bool texture = false,
  }) async {
    final image = await decodeRgba(pixels, frame.columns, frame.rows);
    _preparedImages++;
    _uploadedBytes += pixels.length;
    return FrameRaster(image, texture: texture);
  }

  Future<void> _redraw() async {
    final session = _session;
    final frame = _frame;
    final image = _image;
    if (_seeking != null) {
      _redrawQueued = true;
      return;
    }
    if (frame == null || session == null || image == null || _background) {
      return;
    }
    _painting?.cancel();
    final token = _painting = RayKitCancellation();
    final settings = _render;
    final applied = _appliedRender(frame, settings);
    FrameRaster raster = image;
    var uniforms = _uniforms;
    try {
      if (!identical(settings, _drawnRender)) {
        uniforms = image.texture
            ? MonochromeShader.uniforms(frame, applied)
            : null;
        if (uniforms == null) {
          final pixels = await session.render(
            frame.index,
            applied,
            cancellation: token,
          );
          token.check();
          raster = await _rasterize(pixels, frame);
        }
      }
      await _present(session, frame, raster, uniforms, settings, token);
    } finally {
      if (!identical(raster, image) && !identical(raster, _image)) {
        raster.dispose();
      }
    }
  }

  Future<void> _present(
    RayKitSession session,
    RayKitFrame frame,
    FrameRaster raster,
    List<double>? uniforms,
    Json settings,
    RayKitCancellation token, {
    ({int readUs, Stopwatch draw})? timing,
  }) async {
    final view = _view;
    final spacing = _readPair(frame.geometry['display_spacing_xy'] as List);
    final key = (
      _size,
      _pan,
      _zoom,
      _rotation,
      frame.columns,
      frame.rows,
      spacing.dx,
      spacing.dy,
    );
    var transform = _mapping == key ? _transform : null;
    if (transform == null && !_size.isEmpty) {
      final mapped = await session.transform(
        frame.index,
        view,
        cancellation: token,
      );
      transform = _Transform.fromJson(mapped['transform'] as Json);
    }
    token.check();
    if (!mounted || !identical(session, _session)) {
      throw const RayKitException('cancelled');
    }
    final old = _image;
    setState(() {
      if (_frame?.index != frame.index) {
        _draft.clear();
        _editing = null;
        _editIndex = null;
        _value = '';
      }
      _frame = frame;
      _image = raster;
      _transform = transform;
      _mapping = key;
      _uniforms = uniforms;
      _drawnRender = settings;
      _loading = false;
      final geometry = frame.geometry;
      final directions =
          geometry['increasing_column'] is List &&
          geometry['increasing_row'] is List;
      final calibrated = (geometry['calibration'] as Json)['kind'] != 'none';
      _status =
          'Original · ${frame.columns} × ${frame.rows}${directions ? '' : ' · Orientation unavailable'}${calibrated ? '' : ' · Physical calibration unavailable'}';
    });
    if (!identical(old, raster)) old?.dispose();
    if (transform == null) return;
    final done = Completer<void>();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      done.complete();
      if (!mounted ||
          session != _session ||
          frame != _frame ||
          raster != _image ||
          transform != _transform ||
          !identical(settings, _drawnRender)) {
        return;
      }
      _resumeFrame = frame.index;
      _presentedTransform = transform;
      final presented = _presented = RayKitPresentedFrame(
        source: frame.source,
        revision: session.revision,
        requestId: frame.requestId,
        view: view,
        render: _appliedRender(frame, settings),
        renderer: raster.texture ? 'shader' : 'cpu',
      );
      _presentations++;
      if (timing != null) {
        _frameReadUs = timing.readUs;
        _frameDrawUs = timing.draw.elapsedMicroseconds;
      }
      widget.onPresented?.call(presented);
    });
    await Future.any([done.future, token.cancelled]);
  }

  Json _appliedRender(RayKitFrame frame, Json render) {
    if (render['voi'] != null && frame.selectedView(render['voi']) == null) {
      return Map.of(render)..remove('voi');
    }
    if (render['quantitative'] == true && frame.quantitativeScale == null) {
      return Map.of(render)..remove('quantitative');
    }
    return render;
  }

  void _notifyViewChange() => widget.onViewChange?.call({
    'pan': [_pan.dx, _pan.dy],
    'zoom': _zoom,
    'quarter_turns': _rotation,
  });

  Future<Json> _sample(Offset pixel) async {
    final session = _session;
    final frame = _frame;
    final presented = _presented;
    if (session == null ||
        frame == null ||
        presented?.requestId != frame.requestId) {
      throw const RayKitException('closed');
    }
    final point = await session.sampleAt(
      frame.index,
      (pixel.dx + .5).floor(),
      (pixel.dy + .5).floor(),
    );
    final sample = point['sample'] as Json;
    if (!mounted ||
        session != _session ||
        presented != _presented ||
        frame != _frame) {
      throw const RayKitException('cancelled');
    }
    setState(() {
      _pointer = (frame: frame.index, pixel: pixel);
      _value = sample['kind'] == 'monochrome'
          ? (sample['padding'] == true
                ? 'Padding · stored ${sample['stored']}'
                : 'Stored ${sample['stored']} · ${sample['modality']} ${frame.modalityUnit ?? 'modality'}')
          : '${sample['space']} ${sample['values']}';
      if (point['quantitative'] case final Json quantity) {
        _value +=
            ' · ${(quantity['quantity'] as Json)['meaning']} '
            '${quantity['value']} ${(quantity['unit'] as Json)['value']}';
      }
      if (point['doppler_axes'] case final Json axes) {
        _value +=
            " · Spectral axis ${axes['spectral']} ${axes['spectral_unit']} at ${axes['time']} s";
      }
    });
    return sample;
  }

  Future<void> _setSegmentation(Json metadata, Uint8List mask) async {
    final session = _session;
    final frame = _frame;
    final source = metadata['source'];
    if (frame == null ||
        source is! Json ||
        source['content_sha256'] != frame.source['content_sha256'] ||
        source['instance_uid'] != frame.source['instance_uid'] ||
        source['frame'] != frame.index ||
        !listEquals(metadata['dimensions'] as List?, [
          frame.columns,
          frame.rows,
        ]) ||
        mask.length != frame.columns * frame.rows) {
      throw const RayKitException(
        'integrity',
        'Segmentation does not match the active frame',
      );
    }
    if (mask.length > 4 * 1024 * 1024) {
      throw const RayKitException('limit', 'Overlay pixels');
    }
    final colors = Uint8List(mask.length * 4);
    for (var i = 0; i < mask.length; i++) {
      if (mask[i] != 0) {
        colors.setRange(i * 4, i * 4 + 4, const [66, 220, 190, 135]);
      }
    }
    final raster = FrameRaster(
      await decodeRgba(colors, frame.columns, frame.rows),
      texture: false,
    );
    if (!mounted || frame != _frame || session != _session) {
      raster.dispose();
      throw const RayKitException('cancelled');
    }
    final old = _segmentation;
    setState(() => _segmentation = (frame: frame.index, raster: raster));
    old?.raster.dispose();
  }

  Offset? _pixel(Offset screen) {
    final frame = _frame;
    final transform = _presentedTransform;
    if (frame == null ||
        transform == null ||
        _presented?.requestId != frame.requestId) {
      return null;
    }
    final value = transform.unproject(screen);
    return value.dx >= -0.5 &&
            value.dy >= -0.5 &&
            value.dx < frame.columns - 0.5 &&
            value.dy < frame.rows - 0.5
        ? value
        : null;
  }

  Future<void> _tap(Offset screen) async {
    final tool = _tool;
    if (tool.method == null && tool != _Tool.sample) return;
    await _settle();
    if (!mounted || tool != _tool) return;
    final session = _session;
    final frame = _frame;
    if (session == null || frame == null) return;
    final pixel = _pixel(screen);
    if (pixel == null) return;
    if (_tool == _Tool.sample) {
      final presented = _presented!;
      await _sample(pixel);
      widget.onSamplePoint?.call(presented, pixel);
    } else {
      setState(() => _draft.add(pixel));
    }
  }

  Future<void> _calculate() async {
    await _settle();
    if (!mounted) return;
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
      _notifyViewChange();
    } else if (_tool == _Tool.window) {
      final display = _frame?.display;
      if (display == null) return;
      final voi = display['voi'] as Json;
      final window =
          (_render['window'] ??
                  _frame?.selectedView(_render['voi'])?['window'] ??
                  voi['window'] ??
                  display['automatic_window'])
              as Json;
      final width = (window['width'] as num).toDouble();
      final center = (window['center'] as num).toDouble();
      final delta = focal - last;
      _preset = null;
      _render = {
        ...(Map.of(_render)
          ..remove('voi')
          ..remove('quantitative')),
        'window': {
          ...window,
          'center': center + delta.dy * width / 220,
          'width': (width + delta.dx * width / 220).clamp(1.0, 1e30),
        },
      };
      _run(_redraw());
    }
  }

  void _beginEdit(Offset screen) {
    final transform = _presentedTransform;
    final index = _presented?.source['frame'];
    if (transform == null ||
        index == null ||
        _tool.method == null ||
        _targetFrame != index ||
        _seeking != null) {
      return;
    }
    _pause();
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
          ..addAll(points);
        _editIndex = point;
        _movedLandmark = false;
      });
      return;
    }
  }

  void _moveLandmark(Offset screen) {
    final index = _editIndex;
    final pixel = _pixel(screen);
    if (index == null || pixel == null) return;
    setState(() {
      _draft[index] = pixel;
      _movedLandmark = true;
    });
  }

  void _endEdit() {
    final index = _editIndex;
    _editIndex = null;
    if (index == null) return;
    _run(_movedLandmark ? _calculate() : _replaceLandmark(index));
  }

  Future<void> _replaceLandmark(int index) async {
    final editing = _editing;
    if (editing == null) return;
    final point = await showDialog<Offset>(
      context: context,
      builder: (dialogContext) {
        final source =
            ((editing['input'] as Json)['points'] as List)[index] as Json;
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
    if (!mounted || !identical(_editing, editing)) return;
    if (point == null) {
      setState(() {
        _editing = null;
        _draft.clear();
      });
      return;
    }
    _draft[index] = point;
    await _calculate();
  }

  Future<void> _play([double? rate]) async {
    final session = _session;
    final count = session?.inspection.frames ?? 0;
    if (session == null || count < 2) return;
    if (_playing) {
      await _settle();
      if (!mounted) return;
      setState(() {});
      return;
    }
    final generation = ++_playGeneration;
    setState(() {
      _rate = rate ?? _rate;
      _playing = true;
    });
    final durations =
        session.inspection.frameDurations ?? List.filled(count, 1000 / 15);
    final duration = durations
        .map((ms) => math.max(1000, (ms * 1000 / _rate).round()))
        .toList();
    final cycle = duration.reduce((a, b) => a + b);
    final clock = Stopwatch()..start();
    var index = _presented?.source['frame'] as int? ?? 0;
    var due = duration[index];
    try {
      while (mounted &&
          _playing &&
          generation == _playGeneration &&
          session == _session) {
        final wait = (due - clock.elapsedMicroseconds).clamp(0, 40000);
        await Future<void>.delayed(Duration(microseconds: wait));
        if (generation != _playGeneration || session != _session) return;
        final now = clock.elapsedMicroseconds;
        if (now < due) continue;
        index = (index + 1) % count;
        due += duration[index];
        final cycles = math.max(0, now - due) ~/ cycle;
        _cineSkipped += cycles * count;
        due += cycles * cycle;
        while (due <= now) {
          index = (index + 1) % count;
          due += duration[index];
          _cineSkipped++;
        }
        final before = _presentations;
        await _showFrame(index, prefetch: false);
        if (_presentations > before && _presented?.source['frame'] == index) {
          _cineShown++;
        }
      }
    } on RayKitException catch (error) {
      if (error.code != 'cancelled' || generation == _playGeneration) rethrow;
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

  Future<void> _settle() async {
    final wasPlaying = _playing;
    _pause();
    if (wasPlaying && mounted) setState(() {});
    final target = _targetFrame;
    if (target == null || _session == null) return;
    if (_seeking != null ||
        _pendingSeek != null ||
        _presented?.source['frame'] != target) {
      await _showFrame(target, prefetch: false);
    }
  }

  Future<void> _retire() async {
    _generation++;
    _pause();
    _opening?.cancel();
    _seeking?.cancel();
    _seeking = null;
    _cancelPendingSeek();
    _targetFrame = null;
    _sliderTarget = null;
    _redrawQueued = false;
    _painting?.cancel();
    _prefetching?.cancel();
    final release = _releaseSession;
    _releaseSession = null;
    unawaited(_revoked?.cancel());
    _revoked = null;
    final image = _image;
    _session = null;
    _frame = null;
    _image = null;
    _transform = null;
    _drawnRender = null;
    _uniforms = null;
    _mapping = null;
    _presented = null;
    _frameReadUs = null;
    _frameDrawUs = null;
    _presentedTransform = null;
    _editIndex = null;
    _segmentation?.raster.dispose();
    _segmentation = null;
    image?.dispose();
    final current = release?.call();
    if (current != null) {
      _retired = Future.wait<void>([_retired, current]);
    }
    await _retired;
  }

  void _suspend() {
    if (_background) return;
    _background = true;
    final session = _session;
    if (session != null &&
        !session.isClosed &&
        widget.source.attachedSession == session) {
      _suspendedLease = session.retain();
    }
    _run(_retire());
    if (mounted) setState(() {});
  }

  void _resume() {
    if (!_background) return;
    _background = false;
    final release = _suspendedLease;
    _suspendedLease = null;
    _run(_open().whenComplete(() => release?.call()));
  }

  @override
  void dispose() {
    widget.controller?._detach(this);
    _lifecycle.dispose();
    _target.dispose();
    _radius.dispose();
    unawaited(_suspendedLease?.call());
    _suspendedLease = null;
    unawaited(_retire());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final frame = _frame;
    final count = _session?.inspection.frames ?? 0;
    final image = _image;
    final transform = _transform;
    final records = _visibleRecords(frame);
    final colorScheme = Theme.of(context).colorScheme;
    final choice = frame?.selectedView(_render['voi']);
    final mapping = frame?.quantitativeScale;
    final displayId = _render['quantitative'] == true && mapping != null
        ? 'quantitative'
        : _render['window'] != null
        ? _preset ?? 'manual'
        : choice != null
        ? _voiId(choice)
        : 'initial';
    final pointLabel = _tool.landmarks.isEmpty
        ? ''
        : _tool.landmarks[_draft.length.clamp(0, _tool.landmarks.length - 1)];
    return Column(
      children: [
        if (_session?.inspection.seriesDescription case final description?)
          Text(description, maxLines: 1, overflow: TextOverflow.ellipsis),
        if (widget.showControls)
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              spacing: 8,
              children: [
                DropdownButton<_Tool>(
                  value: _tool,
                  items: _Tool.values
                      .map(
                        (tool) => DropdownMenuItem(
                          value: tool,
                          child: Text(tool.label),
                        ),
                      )
                      .toList(),
                  onChanged: (tool) {
                    if (tool != null) {
                      if (tool != _Tool.pan && tool != _Tool.window) {
                        widget.onReviewStart?.call();
                        _run(_settle());
                      }
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
                          _notifyViewChange();
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
                          _run(_redraw());
                        },
                  child: const Text('Invert'),
                ),
                if (frame != null && frame.display != null)
                  DropdownButton<String>(
                    value: displayId,
                    items: [
                      const DropdownMenuItem(
                        value: 'initial',
                        child: Text('Initial display'),
                      ),
                      for (final entry in frame.views)
                        DropdownMenuItem(
                          value: _voiId(entry),
                          child: Text('Device · ${entry['label']}'),
                        ),
                      if (frame.modalityUnit == 'HU')
                        for (final entry in _presets.entries)
                          DropdownMenuItem(
                            value: entry.key,
                            child: Text(entry.value.label),
                          ),
                      if (mapping != null)
                        DropdownMenuItem(
                          value: 'quantitative',
                          child: Text(
                            (mapping['quantity'] as Json)['meaning'] as String,
                          ),
                        ),
                      if (displayId == 'manual')
                        const DropdownMenuItem(
                          value: 'manual',
                          child: Text('Manual window'),
                        ),
                    ],
                    onChanged: (id) {
                      if (id == null || id == 'manual') return;
                      final preset = _presets[id];
                      final view = frame.views
                          .where((v) => _voiId(v) == id)
                          .firstOrNull;
                      _preset = preset != null ? id : null;
                      _render = {
                        ...(Map.of(_render)
                          ..remove('voi')
                          ..remove('window')
                          ..remove('quantitative')),
                        if (view != null) 'voi': view['selection'],
                        if (id == 'quantitative') 'quantitative': true,
                        if (preset != null)
                          'window': {
                            'center': preset.center,
                            'width': preset.width,
                          },
                      };
                      _run(_redraw());
                    },
                  ),
                PopupMenuButton<String>(
                  tooltip: 'Layers',
                  icon: const Icon(Icons.layers_outlined),
                  itemBuilder: (_) => [
                    for (final tool in _Tool.values)
                      if (tool.method != null)
                        CheckedPopupMenuItem(
                          value: tool.method,
                          checked: !_hiddenLayers.contains(tool.method),
                          child: Text(tool.label),
                        ),
                    CheckedPopupMenuItem(
                      value: 'segmentation',
                      checked: !_hiddenLayers.contains('segmentation'),
                      child: const Text('Segmentation'),
                    ),
                    CheckedPopupMenuItem(
                      value: 'pointer',
                      checked: !_hiddenLayers.contains('pointer'),
                      child: const Text('Pointer'),
                    ),
                  ],
                  onSelected: (layer) => setState(() {
                    if (!_hiddenLayers.remove(layer)) _hiddenLayers.add(layer);
                  }),
                ),
                DropdownButton<String>(
                  value: _render['palette'] == 'hot' ? 'hot' : 'gray',
                  items: const [
                    DropdownMenuItem(
                      value: 'gray',
                      child: Text('Gray palette'),
                    ),
                    DropdownMenuItem(value: 'hot', child: Text('Hot palette')),
                  ],
                  onChanged: frame == null
                      ? null
                      : (value) {
                          if (value == null) return;
                          _render = {..._render, 'palette': value};
                          _run(_redraw());
                        },
                ),
                TextButton(
                  onPressed: frame == null
                      ? null
                      : () {
                          _pan = Offset.zero;
                          _zoom = 1;
                          _rotation = 0;
                          _render = {};
                          _preset = null;
                          _run(_redraw());
                          _notifyViewChange();
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
        if (widget.showControls && _tool == _Tool.tplo)
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
                onLongPressMoveUpdate: (details) =>
                    _moveLandmark(details.localPosition),
                onLongPressEnd: (_) => _endEdit(),
                onScaleStart: (details) {
                  _lastFocal = details.localFocalPoint;
                  _initialZoom = _zoom;
                },
                onScaleUpdate: _scale,
                onScaleEnd: (_) => _lastFocal = null,
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    RepaintBoundary(
                      child: CustomPaint(
                        painter: _ImagePainter(
                          image,
                          transform,
                          _shader,
                          _uniforms,
                          () => _imagePaints++,
                        ),
                      ),
                    ),
                    if (_segmentation case final overlay?
                        when !_hiddenLayers.contains('segmentation') &&
                            overlay.frame == frame?.index)
                      IgnorePointer(
                        child: CustomPaint(
                          painter: _ImagePainter(
                            overlay.raster,
                            transform,
                            null,
                            null,
                            () {},
                            clear: false,
                          ),
                        ),
                      ),
                    if (_pointer case final pointer?
                        when !_hiddenLayers.contains('pointer') &&
                            pointer.frame == frame?.index)
                      IgnorePointer(
                        child: CustomPaint(
                          painter: _PointerPainter(transform, pointer.pixel),
                        ),
                      ),
                    RepaintBoundary(
                      child: CustomPaint(
                        painter: _LandmarkPainter(
                          transform,
                          colorScheme.tertiary,
                          _paths(records),
                        ),
                      ),
                    ),
                    if (records.isNotEmpty)
                      IgnorePointer(
                        child: CustomPaint(
                          painter: _MeasurementDetailsPainter(
                            transform,
                            colorScheme.tertiary,
                            records,
                          ),
                        ),
                      ),
                    RepaintBoundary(
                      child: CustomPaint(
                        painter: _LandmarkPainter(transform, Colors.amber, [
                          List.of(_draft),
                        ]),
                      ),
                    ),
                  ],
                ),
              );
            },
          ),
        ),
        if (displayId == 'quantitative' && mapping != null)
          SizedBox(
            width: 200,
            child: Column(
              children: [
                Container(
                  height: 6,
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      colors: _render['invert'] == true
                          ? const [
                              Colors.white,
                              Colors.yellow,
                              Colors.red,
                              Colors.black,
                            ]
                          : const [
                              Colors.black,
                              Colors.red,
                              Colors.yellow,
                              Colors.white,
                            ],
                    ),
                  ),
                ),
                Text(
                  "${(mapping['value_range'] as List).join(' – ')} ${(mapping['unit'] as Json)['value']}",
                ),
              ],
            ),
          ),
        if (_loading) const LinearProgressIndicator(),
        if (widget.showControls && count > 1)
          Row(
            children: [
              IconButton(
                visualDensity: VisualDensity.compact,
                tooltip: _playing ? 'Pause' : 'Play',
                onPressed: () => _run(_play()),
                icon: Icon(_playing ? Icons.pause : Icons.play_arrow),
              ),
              IconButton(
                visualDensity: VisualDensity.compact,
                tooltip: 'Previous frame',
                onPressed: frame == null || frame.index == 0
                    ? null
                    : () {
                        _run(_navigate(frame.index - 1));
                      },
                icon: const Icon(Icons.skip_previous),
              ),
              IconButton(
                visualDensity: VisualDensity.compact,
                tooltip: 'Next frame',
                onPressed: frame == null || frame.index >= count - 1
                    ? null
                    : () {
                        _run(_navigate(frame.index + 1));
                      },
                icon: const Icon(Icons.skip_next),
              ),
              Expanded(
                child: Slider(
                  label: 'Frame ${(frame?.index ?? 0) + 1} of $count',
                  min: 0,
                  max: (count - 1).toDouble(),
                  value: _sliderTarget ?? (frame?.index ?? 0).toDouble(),
                  divisions: count - 1,
                  onChanged: (v) {
                    setState(() => _sliderTarget = v);
                    _run(_navigate(v.round(), continuous: true));
                  },
                  onChangeEnd: (v) {
                    setState(() => _sliderTarget = null);
                    _run(_navigate(v.round()));
                  },
                ),
              ),
              Text('${(frame?.index ?? 0) + 1} / $count'),
              DropdownButton<double>(
                value: _rate,
                items: ({0.5, 1.0, 2.0, _rate}.toList()..sort())
                    .map((r) => DropdownMenuItem(value: r, child: Text('$r×')))
                    .toList(),
                onChanged: (value) {
                  final playing = _playing;
                  _pause();
                  setState(() => _rate = value ?? 1);
                  if (playing) _run(_play());
                },
              ),
            ],
          ),
        if (widget.showControls)
          Text(
            _status,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
          ),
        if (widget.showControls)
          SizedBox(
            height: MediaQuery.textScalerOf(context).scale(24),
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Center(child: Text(_value)),
            ),
          ),
      ],
    );
  }

  List<Json> _visibleRecords(RayKitFrame? frame) => _measurements
      .where(
        (r) =>
            (r['source'] as Json)['frame'] == frame?.index &&
            (r['source'] as Json)['content_sha256'] ==
                frame?.source['content_sha256'] &&
            !_hiddenLayers.contains((r['input'] as Json)['method']) &&
            r != _editing,
      )
      .toList();

  List<List<Offset>> _paths(List<Json> records) => records.expand((r) {
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
  }).toList();
}

String _voiId(Json view) {
  final selection = view['selection'] as Json;
  return '${selection['kind']}:${selection['index']}';
}

class _PointerPainter extends CustomPainter {
  const _PointerPainter(this.transform, this.point);
  final _Transform? transform;
  final Offset point;

  @override
  void paint(Canvas canvas, Size size) {
    final p = transform?.project(point);
    if (p == null) return;
    final paint = Paint()
      ..color = Colors.amber
      ..strokeWidth = 1.5;
    for (final axis in const [Offset(1, 0), Offset(0, 1)]) {
      canvas.drawLine(p - axis * 10, p - axis * 3, paint);
      canvas.drawLine(p + axis * 3, p + axis * 10, paint);
    }
  }

  @override
  bool shouldRepaint(_PointerPainter oldDelegate) =>
      point != oldDelegate.point || transform != oldDelegate.transform;
}

Offset _readPoint(Json point) =>
    Offset((point['x'] as num).toDouble(), (point['y'] as num).toDouble());
Offset _readPair(List pair) =>
    Offset((pair[0] as num).toDouble(), (pair[1] as num).toDouble());

class _Transform {
  const _Transform(this.origin, this.x, this.y);
  factory _Transform.fromJson(Json json) => _Transform(
    _readPoint(json['origin'] as Json),
    _readPair(json['x_axis'] as List),
    _readPair(json['y_axis'] as List),
  );
  final Offset origin;
  final Offset x;
  final Offset y;
  Float64List get matrix => Float64List.fromList([
    x.dx,
    x.dy,
    0,
    0,
    y.dx,
    y.dy,
    0,
    0,
    0,
    0,
    1,
    0,
    origin.dx,
    origin.dy,
    0,
    1,
  ]);
  Offset project(Offset point) => origin + x * point.dx + y * point.dy;
  Offset unproject(Offset point) {
    final p = point - origin;
    final det = x.dx * y.dy - x.dy * y.dx;
    return Offset(
      (y.dy * p.dx - y.dx * p.dy) / det,
      (x.dx * p.dy - x.dy * p.dx) / det,
    );
  }
}

class _MeasurementDetailsPainter extends CustomPainter {
  const _MeasurementDetailsPainter(this.transform, this.color, this.records);
  final _Transform? transform;
  final Color color;
  final List<Json> records;

  @override
  void paint(Canvas canvas, Size size) {
    final view = transform;
    if (view == null) return;
    canvas.save();
    canvas.clipRect(Offset.zero & size);
    for (final record in records) {
      final input = record['input'] as Json;
      final method = _Tool.values
          .where((tool) => tool.method == input['method'])
          .firstOrNull;
      if (method == null) continue;
      final points = (input['points'] as List).cast<Json>();
      final values = (record['values'] as List).cast<Json>();
      final label = values
          .map(
            (value) =>
                "${(value['value'] as num).toStringAsFixed(2)} ${value['unit']}",
          )
          .join(' / ');
      final text = TextPainter(
        text: TextSpan(
          text: '${method.label} · $label',
          style: TextStyle(
            color: color,
            fontSize: 12,
            backgroundColor: Colors.black87,
          ),
        ),
        textDirection: TextDirection.ltr,
        maxLines: 1,
      )..layout(maxWidth: size.width);
      text.paint(
        canvas,
        view.project(_readPoint(points.first)) + const Offset(7, -16),
      );
      text.dispose();
      final calibration = record['calibration'] as Json;
      if (method != _Tool.tplo || calibration['kind'] != 'projection') continue;
      final radius =
          values
                  .where((value) => value['name'] == 'radius')
                  .firstOrNull?['value']
              as num?;
      if (radius == null || radius <= 0) continue;
      final spacing = _readPair(calibration['spacing_xy'] as List);
      final brush = Paint()
        ..color = color
        ..style = PaintingStyle.stroke
        ..strokeWidth = 0;
      canvas.save();
      canvas.transform(view.matrix);
      canvas.drawOval(
        Rect.fromCenter(
          center: _readPoint(points[4]),
          width: 2 * radius / spacing.dx,
          height: 2 * radius / spacing.dy,
        ),
        brush,
      );
      canvas.restore();
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_MeasurementDetailsPainter previous) =>
      transform != previous.transform ||
      color != previous.color ||
      !listEquals(records, previous.records);
}

class _ImagePainter extends CustomPainter {
  const _ImagePainter(
    this.raster,
    this.transform,
    this.shader,
    this.uniforms,
    this.onPaint, {
    this.clear = true,
  });
  final FrameRaster? raster;
  final _Transform? transform;
  final MonochromeShader? shader;
  final List<double>? uniforms;
  final VoidCallback onPaint;
  final bool clear;
  @override
  void paint(Canvas canvas, Size size) {
    if (clear) {
      canvas.drawRect(Offset.zero & size, Paint()..color = Colors.black);
    }
    final pixels = raster;
    final view = transform;
    if (pixels == null || pixels.disposed || view == null) return;
    onPaint();
    canvas.save();
    canvas.clipRect(Offset.zero & size);
    canvas.transform(view.matrix);
    if (pixels.texture && uniforms != null && shader != null) {
      shader!.draw(canvas, pixels.image, uniforms!);
    } else {
      canvas.drawImage(
        pixels.image,
        const Offset(-0.5, -0.5),
        Paint()..filterQuality = FilterQuality.none,
      );
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_ImagePainter previous) =>
      raster != previous.raster ||
      transform != previous.transform ||
      shader != previous.shader ||
      !listEquals(uniforms, previous.uniforms);
}

class _LandmarkPainter extends CustomPainter {
  const _LandmarkPainter(this.transform, this.color, this.paths);
  final _Transform? transform;
  final Color color;
  final List<List<Offset>> paths;

  @override
  void paint(Canvas canvas, Size size) {
    final view = transform;
    if (view == null) return;
    final paint = Paint()
      ..color = color
      ..strokeWidth = 2;
    canvas.save();
    canvas.clipRect(Offset.zero & size);
    for (final path in paths) {
      Offset? previous;
      for (final source in path) {
        final p = view.project(source);
        if (previous != null) {
          canvas.drawLine(previous, p, paint);
        }
        canvas.drawCircle(p, 3.5, paint);
        previous = p;
      }
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_LandmarkPainter previous) {
    if (transform != previous.transform ||
        color != previous.color ||
        paths.length != previous.paths.length) {
      return true;
    }
    for (var i = 0; i < paths.length; i++) {
      if (!listEquals(paths[i], previous.paths[i])) return true;
    }
    return false;
  }
}

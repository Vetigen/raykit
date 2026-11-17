import 'dart:async';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import 'display.dart';
import 'session.dart';
import 'viewer.dart';

typedef RayKitCapture = ({String acquisition, String frame});

class RayKitLiveFrame {
  const RayKitLiveFrame(
    this.sequence,
    this.arrival,
    this.width,
    this.height,
    this.rgba, {
    this.capture,
  });
  final int sequence;
  final Duration arrival;
  final int width;
  final int height;
  final Uint8List rgba;
  final RayKitCapture? capture;
}

typedef RayKitOriginalBinding = ({
  RayKitCapture capture,
  RayKitSource source,
  String sha256,
  String instanceUid,
  int frame,
});

enum RayKitLiveConnection { idle, streaming, disconnected, ended }

/// Accepts a host-owned stream of decoded preview frames, including native camera
/// and WebRTC adapters. Arrival is in the controller's monotonic local clock.
class RayKitLiveController extends ChangeNotifier {
  RayKitLiveController({this.maxLateness = const Duration(milliseconds: 250)});
  final Duration maxLateness;
  final Stopwatch _clock = Stopwatch()..start();
  Duration get now => _clock.elapsed;
  StreamSubscription<RayKitLiveFrame>? _subscription;
  RayKitLiveFrame? _pending;
  ({RayKitLiveFrame frame, ui.Image image})? _candidate;
  ({RayKitLiveFrame frame, ui.Image image})? _painted;
  ({String id, String revision})? _identity;
  RayKitCancellation? _binding;
  ({RayKitSession session, RayKitSource source, int frame})? _original;
  bool _originalPresented = false;
  bool _frozen = false;
  bool _decoding = false;
  bool _disposed = false;
  int _generation = 0;
  int _lastSequence = -1;
  int _unseen = 0;
  int _skipped = 0;
  RayKitLiveConnection _connection = RayKitLiveConnection.idle;

  RayKitLiveConnection get connection => _connection;
  bool get frozen => _frozen;
  int get unseen => _unseen;
  int get skipped => _skipped;
  int? get presentedSequence => _painted?.frame.sequence;
  Duration? get lastImageAge =>
      _painted == null ? null : now - _painted!.frame.arrival;

  void start({
    required String id,
    required String revision,
    required Stream<RayKitLiveFrame> frames,
  }) {
    if (_disposed) throw const RayKitException('closed');
    if (id.isEmpty || revision.isEmpty) {
      throw const RayKitException('invalid_request', 'Live source identity');
    }
    if (_identity != (id: id, revision: revision)) {
      close();
      _identity = (id: id, revision: revision);
    } else {
      _stop();
    }
    _connection = RayKitLiveConnection.streaming;
    final generation = _generation;
    _subscription = frames.listen(
      (frame) {
        if (generation == _generation) _ingest(frame);
      },
      onDone: () {
        if (generation != _generation) return;
        _connection = RayKitLiveConnection.ended;
        notifyListeners();
      },
      onError: (Object error) {
        if (generation == _generation) disconnect();
      },
    );
    notifyListeners();
  }

  void _ingest(RayKitLiveFrame frame) {
    final pixelCount = frame.width * frame.height;
    final age = now - frame.arrival;
    if (frame.sequence <= _lastSequence ||
        age.abs() > maxLateness ||
        frame.width < 1 ||
        frame.width > 4096 ||
        frame.height < 1 ||
        frame.height > 4096 ||
        pixelCount > 4 * 1024 * 1024 ||
        frame.rgba.length != pixelCount * 4) {
      _skipped++;
      return;
    }
    _lastSequence = frame.sequence;
    if (_pending != null) _skipped++;
    _pending = frame;
    if (_frozen) {
      _unseen++;
      notifyListeners();
    } else {
      unawaited(_decode());
    }
  }

  Future<void> _decode() async {
    final frame = _pending;
    if (_decoding || frame == null || _disposed || _frozen) return;
    final generation = _generation;
    _pending = null;
    _decoding = true;
    try {
      final image = await decodeRgba(frame.rgba, frame.width, frame.height);
      if (generation != _generation ||
          _frozen ||
          now - frame.arrival > maxLateness) {
        image.dispose();
        _skipped++;
        return;
      }
      _discardUnpainted();
      _candidate = (frame: frame, image: image);
      notifyListeners();
    } catch (_) {
      _skipped++;
    } finally {
      _decoding = false;
      if (_pending != null) unawaited(_decode());
    }
  }

  void _didPaint(ui.Image image) {
    final candidate = _candidate;
    if (_disposed ||
        _frozen ||
        candidate == null ||
        candidate.image != image ||
        _painted?.image == image) {
      return;
    }
    _painted?.image.dispose();
    _painted = candidate;
    notifyListeners();
  }

  void _discardUnpainted() {
    final candidate = _candidate;
    if (candidate != null && candidate.image != _painted?.image) {
      candidate.image.dispose();
    }
    _candidate = _painted;
  }

  bool freeze() {
    if (_painted == null) return false;
    if (_frozen) return true;
    _unseen = _pending == null ? 0 : 1;
    _frozen = true;
    _discardUnpainted();
    notifyListeners();
    return true;
  }

  void goLive() {
    _retireOriginal();
    _frozen = false;
    _unseen = 0;
    unawaited(_decode());
    notifyListeners();
  }

  /// The application supplies the authorization and exact capture-to-instance mapping.
  Future<void> bindOriginal(
    Future<RayKitOriginalBinding> Function(RayKitCapture, RayKitCancellation)
    resolve,
  ) async {
    final capture = _painted?.frame.capture;
    if (!_frozen ||
        capture == null ||
        capture.acquisition.isEmpty ||
        capture.frame.isEmpty) {
      throw const RayKitException(
        'geometry',
        'Frozen preview has no exact capture binding',
      );
    }
    _retireOriginal();
    final cancellation = _binding = RayKitCancellation();
    final binding = await resolve(capture, cancellation);
    cancellation.check();
    if (capture != binding.capture ||
        !RegExp(r'^[0-9a-fA-F]{64}$').hasMatch(binding.sha256) ||
        binding.instanceUid.isEmpty ||
        binding.frame < 0) {
      throw const RayKitException(
        'integrity',
        'Original capture identity differs',
      );
    }
    final session = await RayKitSession.open(
      binding.source,
      options: RayKitOpenOptions(
        expectedSha256: binding.sha256,
        expectedInstanceUid: binding.instanceUid,
      ),
      cancellation: cancellation,
    );
    try {
      final info = await session.frameInfo(binding.frame);
      final calibration = (info['geometry'] as Json)['calibration'] as Json;
      final regions = (calibration['regions'] as List? ?? []).cast<Json>();
      if (calibration['kind'] == 'none' ||
          calibration['kind'] == 'ultrasound' &&
              !regions.any(
                (region) =>
                    region['spatial_format'] == 1 &&
                    (region['units_xy'] as List).every((unit) => unit == 3),
              )) {
        throw const RayKitException(
          'geometry',
          'Original capture has no physical calibration',
        );
      }
      await session.readFrame(binding.frame, cancellation: cancellation);
      cancellation.check();
      _original = (
        session: session,
        source: RayKitSource.attached(session),
        frame: binding.frame,
      );
      notifyListeners();
    } catch (_) {
      await session.close();
      rethrow;
    }
  }

  void disconnect() {
    _stop();
    _connection = RayKitLiveConnection.disconnected;
    notifyListeners();
  }

  void _stop() {
    _generation++;
    final subscription = _subscription;
    _subscription = null;
    unawaited(subscription?.cancel());
    _pending = null;
    _discardUnpainted();
  }

  void _retireOriginal() {
    _binding?.cancel();
    final original = _original;
    _original = null;
    _originalPresented = false;
    if (original != null) unawaited(original.session.revoke());
  }

  void _originalDrawn(RayKitPresentedFrame frame) {
    final original = _original;
    if (original == null ||
        _originalPresented ||
        frame.source['frame'] != original.frame ||
        frame.source['content_sha256'] !=
            original.session.inspection.contentSha256) {
      return;
    }
    _originalPresented = true;
    notifyListeners();
  }

  void close() {
    _stop();
    _retireOriginal();
    _painted?.image.dispose();
    _candidate = _painted = null;
    _identity = null;
    _lastSequence = -1;
    _skipped = _unseen = 0;
    _frozen = false;
    _connection = RayKitLiveConnection.idle;
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    close();
    super.dispose();
  }
}

class RayKitLiveView extends StatefulWidget {
  const RayKitLiveView({super.key, required this.controller});
  final RayKitLiveController controller;

  @override
  State<RayKitLiveView> createState() => _RayKitLiveViewState();
}

class _RayKitLiveViewState extends State<RayKitLiveView> {
  late final Timer _age = Timer.periodic(const Duration(seconds: 1), (_) {
    if (mounted &&
        widget.controller.connection != RayKitLiveConnection.streaming) {
      setState(() {});
    }
  });

  @override
  void initState() {
    super.initState();
    _age;
  }

  @override
  void dispose() {
    _age.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final live = widget.controller;
      final image = live._candidate?.image;
      final original = live._original;
      return Column(
        children: [
          Wrap(
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text(
                live._originalPresented
                    ? 'Verified original'
                    : live.frozen
                    ? 'Frozen preview'
                    : 'Live preview',
              ),
              Text(
                ' · ${live.connection.name} · ${live.unseen} new · ${live.skipped} skipped',
              ),
              if (live.lastImageAge case final age?)
                Text(' · ${age.inMilliseconds} ms old'),
              TextButton(
                onPressed: live.frozen
                    ? live.goLive
                    : live.presentedSequence == null
                    ? null
                    : live.freeze,
                child: Text(live.frozen ? 'Return to live' : 'Freeze'),
              ),
            ],
          ),
          Expanded(
            child: original != null
                ? RayKitViewer(
                    source: original.source,
                    initialFrame: original.frame,
                    onPresented: live._originalDrawn,
                  )
                : image == null
                ? const Center(child: Text('Waiting for a preview'))
                : CustomPaint(
                    painter: _PreviewPainter(image, live._didPaint),
                    size: Size.infinite,
                  ),
          ),
        ],
      );
    },
  );
}

class _PreviewPainter extends CustomPainter {
  const _PreviewPainter(this.image, this.presented);
  final ui.Image image;
  final void Function(ui.Image) presented;
  @override
  void paint(Canvas canvas, Size size) {
    final input = Size(image.width.toDouble(), image.height.toDouble());
    final target = Alignment.center.inscribe(
      applyBoxFit(BoxFit.contain, input, size).destination,
      Offset.zero & size,
    );
    canvas.drawImageRect(image, Offset.zero & input, target, Paint());
    WidgetsBinding.instance.addPostFrameCallback((_) => presented(image));
  }

  @override
  bool shouldRepaint(_PreviewPainter oldDelegate) => image != oldDelegate.image;
}

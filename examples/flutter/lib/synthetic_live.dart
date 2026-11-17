import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:raykit/raykit.dart';

class SyntheticLive extends StatefulWidget {
  const SyntheticLive({super.key, required this.source});
  final RayKitSource source;

  @override
  State<SyntheticLive> createState() => _SyntheticLiveState();
}

class _SyntheticLiveState extends State<SyntheticLive> {
  final _live = RayKitLiveController();
  StreamController<RayKitLiveFrame>? _frames;
  Timer? _timer;
  int _sequence = 0;
  String? _error;

  @override
  void initState() {
    super.initState();
    _connect();
  }

  void _connect() {
    final frames = _frames = StreamController<RayKitLiveFrame>();
    _live.start(
      id: 'synthetic-ultrasound',
      revision: '1',
      frames: frames.stream,
    );
    _timer = Timer.periodic(const Duration(milliseconds: 50), (_) {
      final sequence = _sequence++;
      final capture = sequence % 3 == 0
          ? (acquisition: 'synthetic-us-1', frame: '0')
          : null;
      final pixels = Uint8List(8 * 6 * 4);
      for (var i = 0; i < pixels.length; i += 4) {
        pixels[i] = capture != null ? 12 : (i + sequence) % 255;
        pixels[i + 1] = 34;
        pixels[i + 2] = 56;
        pixels[i + 3] = 255;
      }
      frames.add(
        RayKitLiveFrame(sequence, _live.now, 8, 6, pixels, capture: capture),
      );
    });
  }

  void _disconnect() {
    _timer?.cancel();
    _timer = null;
    _live.disconnect();
    unawaited(_frames?.close());
    _frames = null;
  }

  Future<void> _original() async {
    try {
      await _live.bindOriginal((capture, cancel) async {
        final inspection = await RayKitSession.inspect(
          widget.source,
          cancellation: cancel,
        );
        return (
          capture: (acquisition: 'synthetic-us-1', frame: '0'),
          source: widget.source,
          sha256: inspection.contentSha256,
          instanceUid: inspection.instanceUid,
          frame: 0,
        );
      });
      if (mounted) setState(() => _error = null);
    } on RayKitException catch (error) {
      if (mounted) setState(() => _error = error.toString());
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _live.dispose();
    unawaited(_frames?.close());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Synthetic live ultrasound')),
    body: ListenableBuilder(
      listenable: _live,
      builder: (context, _) => Column(
        children: [
          Wrap(
            children: [
              TextButton(
                onPressed: _timer == null ? _connect : _disconnect,
                child: Text(_timer == null ? 'Reconnect' : 'Disconnect'),
              ),
              TextButton(
                onPressed: _live.frozen ? _original : null,
                child: const Text('Verify matching original'),
              ),
              if (_error != null) Text(_error!),
            ],
          ),
          Expanded(child: RayKitLiveView(controller: _live)),
        ],
      ),
    ),
  );
}

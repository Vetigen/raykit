import 'dart:async';

import 'package:flutter/material.dart';

import 'session.dart';
import 'viewer.dart';

typedef RayKitRegistration = ({
  String leftSha256,
  String leftRevision,
  String rightSha256,
  String rightRevision,
  String frameOfReference,
});

/// Linked views of one verified source. Each panel has its own display settings.
class RayKitComparison extends StatefulWidget {
  const RayKitComparison({
    super.key,
    required this.session,
    this.panels = 2,
    this.displayMode = RayKitDisplayMode.auto,
    this.onMeasurement,
    this.otherSession,
    this.registration,
    this.initialFrame = 0,
  }) : assert(panels >= 1 && panels <= 4);

  final RayKitSession session;
  final int panels;
  final RayKitDisplayMode displayMode;
  final ValueChanged<Json>? onMeasurement;
  final RayKitSession? otherSession;
  final RayKitRegistration? registration;
  final int initialFrame;

  @override
  State<RayKitComparison> createState() => _RayKitComparisonState();
}

class _RayKitComparisonState extends State<RayKitComparison> {
  final _controllers = List.generate(4, (_) => RayKitViewerController());
  late RayKitSource _source = RayKitSource.attached(widget.session);
  late RayKitSource? _other = widget.otherSession == null
      ? null
      : RayKitSource.attached(widget.otherSession!);
  int _pointTicket = 0;
  bool _linked = true;
  String? _error;

  @override
  void didUpdateWidget(RayKitComparison oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.session != widget.session) {
      _source = RayKitSource.attached(widget.session);
      _error = null;
    }
    if (oldWidget.otherSession != widget.otherSession) {
      _other = widget.otherSession == null
          ? null
          : RayKitSource.attached(widget.otherSession!);
    }
    if (oldWidget.registration != widget.registration) _pointTicket++;
  }

  Iterable<RayKitViewerController> _peers(int origin) sync* {
    final session = _controllers[origin].session;
    for (var i = 0; i < widget.panels; i++) {
      final controller = _controllers[i];
      if (session != null &&
          controller.session == session &&
          (i == origin || _linked)) {
        yield controller;
      }
    }
  }

  Future<void> _seek(int from, int frame, bool continuous) async {
    await Future.wait(
      _peers(from).map(
        (controller) => continuous
            ? controller.scrub(frame)
            : controller.seek(frame, prefetch: false),
      ),
    );
  }

  void _view(int from, Json view) {
    final pan = view['pan']! as List<double>;
    for (final peer in _peers(from)) {
      if (peer != _controllers[from]) {
        _run(
          peer.setView(
            pan: Offset(pan[0], pan[1]),
            zoom: view['zoom']! as double,
            quarterTurns: view['quarter_turns']! as int,
          ),
        );
      }
    }
  }

  void _point(int from, RayKitPresentedFrame frame, Offset pixel) {
    final ticket = ++_pointTicket;
    for (final peer in _peers(from)) {
      final at = peer.presented;
      if (peer != _controllers[from] &&
          at?.source['frame'] == frame.source['frame'] &&
          at?.revision == frame.revision) {
        _run(peer.pointAt(pixel).then((_) {}));
      }
    }
    if (_linked && widget.registration != null) {
      _run(_projectAcross(from, frame, pixel, ticket));
    }
  }

  Future<void> _projectAcross(
    int from,
    RayKitPresentedFrame frame,
    Offset pixel,
    int ticket,
  ) async {
    final registration = widget.registration!;
    final a = widget.session;
    final b = widget.otherSession;
    if (b == null ||
        a == b ||
        a.inspection.data['study_uid'] == null ||
        a.inspection.data['study_uid'] != b.inspection.data['study_uid'] ||
        a.inspection.contentSha256 != registration.leftSha256 ||
        a.revision != registration.leftRevision ||
        b.inspection.contentSha256 != registration.rightSha256 ||
        b.revision != registration.rightRevision ||
        frame.source['frame_of_reference_uid'] !=
            registration.frameOfReference) {
      return;
    }
    final controller = _controllers[from];
    final session = controller.session;
    if (session != a && session != b) return;
    final info = await session!.frameInfo(frame.source['frame'] as int);
    final plane = (info['geometry'] as Json)['patient_plane'] as Json?;
    if (plane == null) return;
    final origin = (plane['origin'] as List).cast<num>();
    final x = (plane['column_axis'] as List).cast<num>();
    final y = (plane['row_axis'] as List).cast<num>();
    final spacing = (plane['spacing_xy'] as List).cast<num>();
    final patient = List.generate(
      3,
      (i) =>
          origin[i] +
          x[i] * pixel.dx * spacing[0] +
          y[i] * pixel.dy * spacing[1],
    );
    final normal = List.generate(
      3,
      (i) => x[(i + 1) % 3] * y[(i + 2) % 3] - x[(i + 2) % 3] * y[(i + 1) % 3],
    );
    final target = session == a ? b : a;
    final match = await target.locatePatient(
      patient,
      registration.frameOfReference,
      normal,
    );
    if (match == null ||
        !mounted ||
        !_linked ||
        ticket != _pointTicket ||
        controller.presented != frame ||
        widget.registration != registration) {
      return;
    }
    final next = match['frame'] as int;
    final coord = match['pixel'] as Json;
    for (final peer
        in _controllers.take(widget.panels).where((c) => c.session == target)) {
      if (peer.presented?.source['frame'] != next) {
        await peer.seek(next, prefetch: false);
      }
      if (!mounted ||
          !_linked ||
          ticket != _pointTicket ||
          controller.presented != frame ||
          peer.session != target ||
          peer.presented?.source['frame'] != next) {
        return;
      }
      await peer.pointAt(
        Offset((coord['x'] as num).toDouble(), (coord['y'] as num).toDouble()),
      );
    }
  }

  void _run(Future<void> work) {
    unawaited(
      work.catchError((Object error) {
        if (!mounted ||
            error is RayKitException &&
                ['cancelled', 'closed'].contains(error.code)) {
          return;
        }
        setState(
          () => _error = error is RayKitException
              ? error.toString()
              : 'Comparison could not be updated.',
        );
      }),
    );
  }

  Widget _panel(int i) => RayKitViewer(
    key: ValueKey(i),
    source: i.isOdd ? _other ?? _source : _source,
    controller: _controllers[i],
    displayMode: widget.displayMode,
    initialFrame: i.isOdd && _other != null ? 0 : widget.initialFrame,
    initialRender: _other == null
        ? {
            'voi': {'kind': 'window', 'index': i % 2},
          }
        : const {},
    onSeek: (index, continuous) => _seek(i, index, continuous),
    onViewChange: (view) => _view(i, view),
    onSamplePoint: (frame, point) => _point(i, frame, point),
    onMeasurement: widget.onMeasurement,
  );

  @override
  Widget build(BuildContext context) => Column(
    children: [
      Row(
        children: [
          Checkbox(
            value: _linked,
            onChanged: (value) => setState(() => _linked = value ?? false),
          ),
          const Text('Link views'),
          if (_error case final error?) Flexible(child: Text(error)),
        ],
      ),
      Expanded(
        child: Column(
          children: [
            for (var row = 0; row < (widget.panels + 1) ~/ 2; row++)
              Expanded(
                child: Row(
                  children: [
                    for (
                      var i = 2 * row;
                      i < widget.panels && i < 2 * row + 2;
                      i++
                    )
                      Expanded(child: _panel(i)),
                  ],
                ),
              ),
          ],
        ),
      ),
    ],
  );
}

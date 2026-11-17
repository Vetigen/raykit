import 'dart:async';

import 'package:flutter/material.dart';

import 'session.dart';
import 'viewer.dart';

class RayKitSeriesMember {
  const RayKitSeriesMember({
    required this.instanceUid,
    required this.revision,
    required this.source,
    required this.sha256,
    required this.bytes,
    this.acquiredAt,
  });
  final String instanceUid;
  final String revision;
  final RayKitSource source;
  final String sha256;
  final int bytes;
  final DateTime? acquiredAt;
}

class RayKitProgressiveSeries extends ChangeNotifier {
  RayKitProgressiveSeries({
    required this.revision,
    this.studyUid,
    this.seriesUid,
  });
  final String revision;
  final String? studyUid;
  final String? seriesUid;
  final _members = <(String, String), (RayKitSeriesMember, int)>{};
  bool _connected = true;
  bool get connected => _connected;
  List<RayKitSeriesMember> get members =>
      _members.values.map((row) => row.$1).toList(growable: false);

  RayKitSeriesMember? get latest {
    final rows = _members.values;
    return rows.isEmpty
        ? null
        : rows.reduce((a, b) {
            final first = a.$1.acquiredAt;
            final second = b.$1.acquiredAt;
            final time = first != null && second != null
                ? first.compareTo(second)
                : 0;
            return (time == 0 ? a.$2.compareTo(b.$2) : time) > 0 ? a : b;
          }).$1;
  }

  int append(
    String manifestRevision,
    int sequence,
    List<RayKitSeriesMember> members,
  ) {
    if (revision != manifestRevision) {
      throw const RayKitException('integrity', 'Series revision');
    }
    if (sequence < 0 || members.length > 4096) {
      throw const RayKitException('invalid_request', 'Series delta');
    }
    final added = <(String, String), (RayKitSeriesMember, int)>{};
    for (final member in members) {
      if (member.instanceUid.isEmpty ||
          member.revision.isEmpty ||
          member.bytes < 1 ||
          !RegExp(r'^[a-fA-F0-9]{64}$').hasMatch(member.sha256)) {
        throw const RayKitException(
          'invalid_request',
          'Series member identity',
        );
      }
      final id = (member.instanceUid, member.revision);
      final previous = (_members[id] ?? added[id])?.$1;
      if (previous != null) {
        if (previous.sha256 != member.sha256 ||
            previous.bytes != member.bytes ||
            previous.acquiredAt != member.acquiredAt) {
          throw const RayKitException(
            'integrity',
            'Series member changed in place',
          );
        }
      } else {
        added[id] = (member, sequence);
      }
    }
    if (added.length + _members.length > 4096) {
      throw const RayKitException('limit', 'Series member count');
    }
    _members.addAll(added);
    if (added.isNotEmpty) notifyListeners();
    return added.length;
  }

  void setConnected(bool connected) {
    if (connected == _connected) return;
    _connected = connected;
    notifyListeners();
  }

  Future<RayKitSession> open(
    RayKitSeriesMember member,
    RayKitCancellation cancellation,
  ) {
    final source = _members[(member.instanceUid, member.revision)]?.$1;
    if (source == null) {
      throw const RayKitException('invalid_request', 'Unknown series member');
    }
    return RayKitSession.open(
      source.source,
      cancellation: cancellation,
      options: RayKitOpenOptions(
        expectedInstanceUid: source.instanceUid,
        expectedSha256: source.sha256,
        expectedSize: source.bytes,
        expectedStudyUid: studyUid,
        expectedSeriesUid: seriesUid,
        revision: source.revision,
      ),
    );
  }
}

class RayKitLiveSeriesView extends StatefulWidget {
  const RayKitLiveSeriesView({
    super.key,
    required this.series,
    this.onMeasurement,
  });
  final RayKitProgressiveSeries series;
  final ValueChanged<Json>? onMeasurement;
  @override
  State<RayKitLiveSeriesView> createState() => _RayKitLiveSeriesViewState();
}

class _RayKitLiveSeriesViewState extends State<RayKitLiveSeriesView> {
  bool _following = true;
  RayKitSeriesMember? _shown;
  RayKitSeriesMember? _opening;
  RayKitCancellation? _token;
  RayKitSession? _session;
  RayKitSource? _source;
  String? _error;
  int _seen = 0;
  final _time = Stopwatch()..start();
  Duration? _lastImage;
  Timer? _age;

  @override
  void initState() {
    super.initState();
    widget.series.addListener(_update);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _update();
    });
    _age = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && _lastImage != null) setState(() {});
    });
  }

  @override
  void didUpdateWidget(RayKitLiveSeriesView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.series == widget.series) return;
    oldWidget.series.removeListener(_update);
    _clear();
    widget.series.addListener(_update);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _update();
    });
  }

  void _update() {
    if (!widget.series.connected) {
      _token?.cancel();
      _opening = null;
    }
    final latest = widget.series.latest;
    if (_following &&
        widget.series.connected &&
        latest != null &&
        latest != _shown &&
        latest != _opening) {
      unawaited(_show(latest));
    }
    setState(() {});
  }

  void _freeze() {
    if (!_following) return;
    _token?.cancel();
    _opening = null;
    setState(() {
      _following = false;
      _seen = widget.series.members.length;
    });
  }

  Future<void> _show(RayKitSeriesMember member) async {
    _token?.cancel();
    _opening = member;
    final token = _token = RayKitCancellation();
    RayKitSession? session;
    try {
      session = await widget.series.open(member, token);
      await session.readFrame(0, cancellation: token);
      token.check();
      if (!mounted) return;
      final previous = _session;
      setState(() {
        _session = session;
        _source = RayKitSource.attached(session!);
        _shown = member;
        _error = null;
        if (_following) _seen = widget.series.members.length;
      });
      session = null;
      unawaited(previous?.close());
    } on RayKitException catch (error) {
      if (mounted && !token.isCancelled) {
        setState(() => _error = error.toString());
      }
    } finally {
      await session?.close();
      if (_token == token) _opening = null;
    }
  }

  void _clear() {
    _token?.cancel();
    unawaited(_session?.revoke());
    _session = null;
    _source = null;
    _shown = _opening = null;
    _lastImage = null;
    _seen = 0;
    _following = true;
  }

  @override
  void dispose() {
    widget.series.removeListener(_update);
    _age?.cancel();
    _clear();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final series = widget.series;
    final members = series.members;
    final source = _source;
    return Column(
      children: [
        Wrap(
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(
              !series.connected
                  ? 'Disconnected'
                  : _following
                  ? 'Following live acquisitions'
                  : 'Frozen original',
            ),
            if (!_following)
              Text(' · ${(members.length - _seen).clamp(0, 4096)} new'),
            if (!series.connected && _lastImage != null)
              Text(' · ${(_time.elapsed - _lastImage!).inSeconds} s old'),
            TextButton(
              onPressed: _following
                  ? _freeze
                  : () {
                      _following = true;
                      _update();
                    },
              child: Text(_following ? 'Freeze' : 'Return to live'),
            ),
            if (members.isNotEmpty)
              DropdownButton<RayKitSeriesMember>(
                value: _shown,
                hint: const Text('Acquisition'),
                items: [
                  for (var i = 0; i < members.length; i++)
                    DropdownMenuItem(
                      value: members[i],
                      child: Text('Acquisition ${i + 1}'),
                    ),
                ],
                onChanged: (member) {
                  if (member != null) {
                    _freeze();
                    unawaited(_show(member));
                  }
                },
              ),
            if (_error != null) Text(_error!),
          ],
        ),
        Expanded(
          child: source == null
              ? const Center(child: Text('Waiting for an acquisition'))
              : RayKitViewer(
                  source: source,
                  onMeasurement: widget.onMeasurement,
                  onReviewStart: _freeze,
                  onPresented: (_) {
                    _lastImage = _time.elapsed;
                  },
                ),
        ),
      ],
    );
  }
}

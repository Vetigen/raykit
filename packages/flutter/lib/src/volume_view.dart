import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'display.dart';
import 'session.dart';

/// Patient-space reformat of an acquired CT/MR series. The host owns the session.
class RayKitVolumeView extends StatefulWidget {
  const RayKitVolumeView({super.key, required this.session});
  final RayKitSession session;

  @override
  State<RayKitVolumeView> createState() => _RayKitVolumeViewState();
}

class _RayKitVolumeViewState extends State<RayKitVolumeView> {
  RayKitCancellation? _pending;
  Json? _volume;
  List<Json> _candidates = [];
  int _candidate = 0;
  FrameRaster? _image;
  String _orientation = 'axial';
  String _slab = 'single';
  String _palette = 'gray';
  String _status = 'Preparing volume…';
  double _offset = 0, _span = 6, _center = 200, _width = 800;

  @override
  void initState() {
    super.initState();
    unawaited(_buildVolume());
  }

  @override
  void didUpdateWidget(RayKitVolumeView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.session != widget.session) {
      _candidate = 0;
      _candidates = [];
      unawaited(_buildVolume());
    }
  }

  RayKitCancellation _replaceWork() {
    _pending?.cancel();
    return _pending = RayKitCancellation();
  }

  Future<void> _buildVolume() async {
    final session = widget.session;
    final token = _replaceWork();
    _image?.dispose();
    setState(() {
      _image = null;
      _volume = null;
      _status = 'Preparing volume…';
    });
    try {
      final result = await session.volumeCandidates(cancellation: token);
      token.check();
      final candidates = (result['candidates'] as List).cast<Json>();
      setState(() => _candidates = candidates);
      if (candidates.isEmpty) {
        throw const RayKitException('geometry', 'No CT/MR acquisitions');
      }
      if (_candidate >= candidates.length) _candidate = 0;
      final metadata = await session.buildVolume(
        _candidate,
        result['revision'] as int,
        cancellation: token,
      );
      token.check();
      final dims = (metadata['dimensions'] as List).cast<int>();
      final step = _vector(metadata['slice_step_mm']);
      setState(() {
        _volume = metadata;
        _offset = 0;
        _span = math.max(6, _norm(step) * (dims[2] - 1) / 2);
      });
      await _draw();
    } on RayKitException catch (error) {
      if (mounted && !token.isCancelled) {
        setState(() => _status = error.toString());
      }
    }
  }

  Future<void> _draw() async {
    final volume = _volume;
    if (volume == null) return;
    final token = _replaceWork();
    final geometry = volume['plane'] as Json;
    final column = _vector(geometry['column_axis']);
    final row = _vector(geometry['row_axis']);
    final normal = _cross(column, row);
    final tilted = List<double>.generate(
      3,
      (i) => (row[i] + normal[i]) / math.sqrt2,
    );
    final direction = switch (_orientation) {
      'axial' => [0.0, 0.0, 1.0],
      'coronal' => [0.0, 1.0, 0.0],
      'sagittal' => [1.0, 0.0, 0.0],
      _ => _cross(column, tilted),
    };
    final center = _vector(volume['center']);
    final dims = (volume['dimensions'] as List).cast<int>();
    final pixelSize = _vector(geometry['spacing_xy']);
    final sliceSize = _norm(_vector(volume['slice_step_mm']));
    final spacing =
        [
          dims[0] * pixelSize[0],
          dims[1] * pixelSize[1],
          dims[2] * sliceSize,
        ].reduce(math.max) /
        200;
    const size = 256;
    try {
      final result = await widget.session.reslice(
        {
          'center': List<double>.generate(
            3,
            (i) => center[i] + _offset * direction[i],
          ),
          'orientation': {
            'kind': _orientation,
            if (_orientation == 'oblique') 'axes': [...column, ...tilted],
          },
          'dimensions': [size, size],
          'spacing_xy': [spacing, spacing],
          'slab': {'kind': _slab, if (_slab != 'single') 'thickness_mm': 5.0},
        },
        window: {'center': _center, 'width': _width},
        palette: _palette,
        cancellation: token,
      );
      token.check();
      final image = FrameRaster(await decodeRgba(result.pixels, size, size));
      if (!mounted || token.isCancelled) {
        image.dispose();
        return;
      }
      _image?.dispose();
      setState(() {
        _image = image;
        _status =
            '${dims[2]} source slices · ${dims[0]} × ${dims[1]} · $_orientation';
      });
    } catch (error) {
      if (mounted && !token.isCancelled) {
        _image?.dispose();
        setState(() {
          _image = null;
          _status = error is RayKitException
              ? error.toString()
              : 'Unable to draw volume';
        });
      }
    }
  }

  @override
  void dispose() {
    _pending?.cancel();
    _image?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Column(
    children: [
      Wrap(
        spacing: 12,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          DropdownButton<int>(
            value: _candidates.isEmpty ? null : _candidate,
            items: [
              for (var i = 0; i < _candidates.length; i++)
                DropdownMenuItem(value: i, child: Text('Acquisition ${i + 1}')),
            ],
            onChanged: (i) {
              if (i != null) {
                _candidate = i;
                unawaited(_buildVolume());
              }
            },
          ),
          _select(_orientation, {
            'axial': 'Axial',
            'coronal': 'Coronal',
            'sagittal': 'Sagittal',
            'oblique': 'Oblique',
          }, (v) => _orientation = v),
          _select(_slab, {
            'single': 'Single',
            'average': 'Average 5 mm',
            'maximum': 'MIP 5 mm',
          }, (v) => _slab = v),
          _select(_palette, {
            'gray': 'Gray',
            'hot': 'Hot',
          }, (v) => _palette = v),
        ],
      ),
      Row(
        children: [
          const Text('Offset'),
          Expanded(
            child: Slider(
              value: _offset,
              min: -_span,
              max: _span,
              onChanged: _volume == null
                  ? null
                  : (v) {
                      setState(() => _offset = v);
                      unawaited(_draw());
                    },
            ),
          ),
        ],
      ),
      Row(
        children: [
          const Text('W/L'),
          Expanded(
            child: Slider(
              value: _center,
              min: -1000,
              max: 2000,
              onChanged: _volume == null
                  ? null
                  : (v) {
                      setState(() => _center = v);
                      unawaited(_draw());
                    },
            ),
          ),
          Expanded(
            child: Slider(
              value: _width,
              min: 1,
              max: 3000,
              onChanged: _volume == null
                  ? null
                  : (v) {
                      setState(() => _width = v);
                      unawaited(_draw());
                    },
            ),
          ),
        ],
      ),
      Expanded(
        child: ColoredBox(
          color: Colors.black,
          child: Center(
            child: _image == null
                ? null
                : RawImage(
                    image: _image!.image,
                    fit: BoxFit.contain,
                    filterQuality: FilterQuality.none,
                  ),
          ),
        ),
      ),
      Text(_status),
    ],
  );

  DropdownButton<String> _select(
    String value,
    Map<String, String> items,
    ValueChanged<String> select,
  ) => DropdownButton(
    value: value,
    items: [
      for (final entry in items.entries)
        DropdownMenuItem(value: entry.key, child: Text(entry.value)),
    ],
    onChanged: _volume == null
        ? null
        : (v) {
            if (v != null) {
              setState(() => select(v));
              unawaited(_draw());
            }
          },
  );
}

List<double> _vector(Object? values) =>
    (values as List).cast<num>().map((v) => v.toDouble()).toList();
double _norm(List<double> vector) =>
    math.sqrt(vector.fold(0.0, (sum, v) => sum + v * v));
List<double> _cross(List<double> a, List<double> b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

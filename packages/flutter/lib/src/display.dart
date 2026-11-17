import 'dart:typed_data';
import 'dart:ui' as ui;

import 'session.dart';

final class FrameRaster {
  FrameRaster(this.image, {this.texture = false});
  final ui.Image image;
  final bool texture;
  bool disposed = false;
  int get bytes => image.width * image.height * 4;

  void dispose() {
    if (disposed) return;
    disposed = true;
    image.dispose();
  }
}

final class MonochromeShader {
  MonochromeShader(this.program);
  final ui.FragmentProgram program;
  static Future<MonochromeShader?>? _probe;

  static Future<MonochromeShader?> available() =>
      _probe ??= testedProgram('packages/raykit/shaders/monochrome.frag');

  static Future<MonochromeShader?> testedProgram(String assetKey) async {
    try {
      final program = await ui.FragmentProgram.fromAsset(assetKey);
      final shader = MonochromeShader(program);
      // A backend must preserve both byte channels and sample pixel centers.
      // Values -2048 (padding), -1541, -1540, -1539 under an inverted narrow window.
      final packed = Uint8List.fromList([
        0,
        248,
        0,
        255,
        251,
        249,
        0,
        255,
        252,
        249,
        0,
        255,
        253,
        249,
        0,
        255,
      ]);
      final image = await decodeRgba(packed, 2, 2);
      try {
        final recorder = ui.PictureRecorder();
        final canvas = ui.Canvas(recorder)..translate(0.5, 0.5);
        shader.draw(canvas, image, [-1540, 2, 0, 1, 1, -2048, -2048, 1, 0]);
        final picture = recorder.endRecording();
        try {
          final rendered = await picture.toImage(2, 2);
          try {
            final bytes = await rendered.toByteData(
              format: ui.ImageByteFormat.rawRgba,
            );
            const gray = [0, 255, 128, 0];
            if (bytes == null) return null;
            for (var p = 0; p < gray.length; p++) {
              for (var c = 0; c < 3; c++) {
                if ((bytes.getUint8(p * 4 + c) - gray[p]).abs() > 1) {
                  return null;
                }
              }
              if (bytes.getUint8(p * 4 + 3) != 255) return null;
            }
            return shader;
          } finally {
            rendered.dispose();
          }
        } finally {
          picture.dispose();
        }
      } finally {
        image.dispose();
      }
    } catch (_) {
      return null;
    }
  }

  static List<double>? uniforms(RayKitFrame frame, Json options) {
    if (options.keys.any(
          (key) => !const ['window', 'invert', 'palette'].contains(key),
        ) ||
        (options.containsKey('invert') && options['invert'] is! bool) ||
        (options.containsKey('palette') &&
            !const ['gray', 'hot'].contains(options['palette']))) {
      return null;
    }
    final display = frame.display;
    if (display == null) return null;
    final modality = display['modality'] as Json;
    if (modality['kind'] != 'linear') return null;
    final voi = display['voi'] as Json;
    final window = options['window'] ?? voi['window'];
    if (window is! Json ||
        window['center'] is! num ||
        window['width'] is! num ||
        window.keys.any(
          (key) => !const ['center', 'width', 'function'].contains(key),
        ) ||
        (window.containsKey('function') &&
            !const [
              'linear',
              'linear_exact',
              'sigmoid',
            ].contains(window['function']))) {
      return null;
    }
    final slope = (modality['slope'] as num).toDouble();
    final intercept = (modality['intercept'] as num).toDouble();
    final linear = (window['function'] ?? 'linear') == 'linear';
    final rawWidth = (window['width'] as num).toDouble();
    if (!rawWidth.isFinite || rawWidth <= 0) return null;
    final target = (window['center'] as num).toDouble() - (linear ? 0.5 : 0);
    final center = (target - intercept) / slope;
    final width = (rawWidth - (linear ? 1 : 0)) / slope.abs();
    final floats = Float32List.fromList([center, width]);
    final arithmeticError =
        (target.abs() + intercept.abs() + 65536 * slope.abs()) *
        1e-15 /
        slope.abs();
    final uniformError = (center - floats[0]).abs() + (width - floats[1]).abs();
    final error = arithmeticError + uniformError;
    if (!floats[0].isFinite ||
        !floats[1].isFinite ||
        width < 0 ||
        (width == 0
            ? (center - center.round()).abs() <= error
            : error * 2048 > width || floats[1] == 0)) {
      return null;
    }
    final padding = display['padding'] as List?;
    return [
      center,
      width,
      window['function'] == 'sigmoid' ? 1 : 0,
      slope < 0 ? -1 : 1,
      (display['inverse'] == true) != (options['invert'] == true) ? 1 : 0,
      (padding?[0] as num?)?.toDouble() ?? 1,
      (padding?[1] as num?)?.toDouble() ?? 0,
      (frame.data['format'] as Json)['signed'] == true ? 1 : 0,
      options['palette'] == 'hot' ? 1 : 0,
    ];
  }

  void draw(ui.Canvas canvas, ui.Image image, List<double> uniforms) {
    final shader = program.fragmentShader();
    try {
      shader.setImageSampler(0, image);
      shader.setFloat(0, image.width.toDouble());
      shader.setFloat(1, image.height.toDouble());
      for (var i = 0; i < uniforms.length; i++) {
        shader.setFloat(i + 2, uniforms[i]);
      }
      canvas.drawRect(
        ui.Rect.fromLTWH(
          -0.5,
          -0.5,
          image.width.toDouble(),
          image.height.toDouble(),
        ),
        ui.Paint()
          ..shader = shader
          ..isAntiAlias = false,
      );
    } finally {
      shader.dispose();
    }
  }
}

Future<ui.Image> decodeRgba(Uint8List rgba, int width, int height) async {
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

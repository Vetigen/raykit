#include <flutter/runtime_effect.glsl>

precision highp float;
uniform vec2 dimensions;
uniform float center;
uniform float width;
uniform float functionKind;
uniform float slopeSign;
uniform float presentationInverse;
uniform float paddingLow;
uniform float paddingHigh;
uniform float isSigned;
uniform float hot;
uniform sampler2D stored;
out vec4 color;

void main() {
  // Sample the center of the packed texel before reconstructing the integer.
  vec2 at = clamp(floor(FlutterFragCoord().xy + 0.5), vec2(0.0), dimensions - 1.0);
  vec2 bytes = floor(texture(stored, (at + 0.5) / dimensions).rg * 255.0 + 0.5);
  float sampleValue = bytes.x + bytes.y * 256.0;
  if (isSigned > 0.5 && sampleValue >= 32768.0) sampleValue -= 65536.0;
  if (sampleValue >= paddingLow && sampleValue <= paddingHigh) {
    color = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float delta = (sampleValue - center) * slopeSign;
  float level;
  if (width == 0.0) level = delta > 0.0 ? 1.0 : 0.0;
  else if (functionKind > 0.5) level = 1.0 / (1.0 + exp(-4.0 * delta / width));
  else level = clamp(delta / width + 0.5, 0.0, 1.0);
  if (presentationInverse > 0.5) level = 1.0 - level;
  vec3 rgb = hot > 0.5 ? clamp(3.0 * level - vec3(0, 1, 2), 0.0, 1.0) : vec3(level);
  color = vec4(floor(rgb * 255.0 + 0.5) / 255.0, 1.0);
}

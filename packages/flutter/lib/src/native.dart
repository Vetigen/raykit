import 'dart:convert';
import 'dart:ffi';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

const _asset = 'package:raykit/src/native.dart';

final class _Buffer extends Struct {
  external Pointer<Uint8> data;
  @Size()
  external int length;
}

final class _Response extends Struct {
  @Uint64()
  external int handle;
  external _Buffer metadata;
  external _Buffer payload;
}

@Native<Uint32 Function()>(symbol: 'raykit_v1_abi_version', assetId: _asset)
external int abiVersion();

@Native<Uint32 Function(Pointer<_Response>)>(
  symbol: 'raykit_v1_capabilities',
  assetId: _asset,
)
external int _capabilities(Pointer<_Response> out);

@Native<
  Uint32 Function(
    Pointer<Uint8>,
    Size,
    Pointer<Uint8>,
    Size,
    Pointer<_Response>,
  )
>(symbol: 'raykit_v1_open', assetId: _asset)
external int _open(
  Pointer<Uint8> input,
  int len,
  Pointer<Uint8> options,
  int optionsLen,
  Pointer<_Response> out,
);

@Native<
  Uint32 Function(
    Uint64,
    Pointer<Uint8>,
    Size,
    Pointer<Uint8>,
    Size,
    Pointer<_Response>,
  )
>(symbol: 'raykit_v1_append', assetId: _asset)
external int _append(
  int handle,
  Pointer<Uint8> bytes,
  int len,
  Pointer<Uint8> options,
  int optionsLen,
  Pointer<_Response> out,
);

@Native<Uint32 Function(Uint64, Pointer<Uint8>, Size, Pointer<_Response>)>(
  symbol: 'raykit_v1_request',
  assetId: _asset,
)
external int _request(
  int handle,
  Pointer<Uint8> command,
  int len,
  Pointer<_Response> out,
);

@Native<Void Function(Uint64)>(symbol: 'raykit_v1_close', assetId: _asset)
external void closeHandle(int handle);

@Native<Void Function(Pointer<Uint8>, Size)>(
  symbol: 'raykit_v1_free',
  assetId: _asset,
)
external void _free(Pointer<Uint8> bytes, int len);

@Native<Size Function()>(symbol: 'raykit_v1_live_sessions', assetId: _asset)
external int liveSessions();

typedef NativeReply = ({
  int status,
  int handle,
  Object? metadata,
  Uint8List? bytes,
});

NativeReply _call(int Function(Pointer<_Response>) invoke) {
  final pointer = calloc<_Response>();
  try {
    final status = invoke(pointer);
    final response = pointer.ref;
    final meta = response.metadata;
    final data = response.payload;
    final metadata = meta.length == 0
        ? null
        : jsonDecode(utf8.decode(meta.data.asTypedList(meta.length)));
    final bytes = data.length == 0
        ? null
        : Uint8List.fromList(data.data.asTypedList(data.length));
    return (
      status: status,
      handle: response.handle,
      metadata: metadata,
      bytes: bytes,
    );
  } finally {
    final response = pointer.ref;
    _free(response.metadata.data, response.metadata.length);
    _free(response.payload.data, response.payload.length);
    calloc.free(pointer);
  }
}

Pointer<Uint8> _copy(Uint8List data) {
  if (data.isEmpty) return nullptr;
  final pointer = malloc<Uint8>(data.length);
  pointer.asTypedList(data.length).setAll(0, data);
  return pointer;
}

NativeReply openNative(
  Uint8List bytes,
  Map<String, Object?> options, {
  int? handle,
}) {
  final settings = utf8.encode(jsonEncode(options));
  final settingsPointer = _copy(settings);
  try {
    final data = _copy(bytes);
    try {
      return _call(
        (out) => handle == null
            ? _open(data, bytes.length, settingsPointer, settings.length, out)
            : _append(
                handle,
                data,
                bytes.length,
                settingsPointer,
                settings.length,
                out,
              ),
      );
    } finally {
      if (data != nullptr) malloc.free(data);
    }
  } finally {
    malloc.free(settingsPointer);
  }
}

NativeReply requestNative(int handle, Map<String, Object?> command) {
  final bytes = utf8.encode(jsonEncode(command));
  final data = _copy(bytes);
  try {
    return _call((out) => _request(handle, data, bytes.length, out));
  } finally {
    malloc.free(data);
  }
}

NativeReply capabilitiesNative() => _call(_capabilities);

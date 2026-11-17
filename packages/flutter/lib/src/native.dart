import 'dart:convert';
import 'dart:ffi';
import 'dart:isolate';
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
    Pointer<Uint8>,
    Size,
    Pointer<Uint8>,
    Size,
    Pointer<Uint8>,
    Size,
    Pointer<Uint8>,
    Size,
    Pointer<_Response>,
  )
>(symbol: 'raykit_v1_open_file', assetId: _asset)
external int _openFile(
  Pointer<Uint8> path,
  int pathLen,
  Pointer<Uint8> index,
  int indexLen,
  Pointer<Uint8> pin,
  int pinLen,
  Pointer<Uint8> options,
  int optionsLen,
  Pointer<_Response> out,
);

@Native<
  Uint32 Function(
    Int32,
    Pointer<Uint8>,
    Size,
    Pointer<Uint8>,
    Size,
    Pointer<Uint8>,
    Size,
    Pointer<_Response>,
  )
>(symbol: 'raykit_v1_open_descriptor', assetId: _asset)
external int _openDescriptor(
  int fd,
  Pointer<Uint8> index,
  int indexLen,
  Pointer<Uint8> pin,
  int pinLen,
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
>(symbol: 'raykit_v1_append_file', assetId: _asset)
external int _appendFile(
  int handle,
  Pointer<Uint8> path,
  int pathLen,
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

@Native<Size Function()>(symbol: 'raykit_v1_live_buffers', assetId: _asset)
external int liveBuffers();

typedef NativeReply = ({
  int status,
  int handle,
  Object? metadata,
  TransferableTypedData? bytes,
  int byteLength,
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
        : TransferableTypedData.fromList([data.data.asTypedList(data.length)]);
    return (
      status: status,
      handle: response.handle,
      metadata: metadata,
      bytes: bytes,
      byteLength: data.length,
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

NativeReply openLocal(
  Object location,
  Map<String, Object?> options, {
  int? handle,
  Uint8List? index,
  String? sha256,
}) {
  return using((arena) {
    Pointer<Uint8> copy(List<int> bytes) =>
        bytes.isEmpty ? nullptr : arena<Uint8>(bytes.length)
          ..asTypedList(bytes.length).setAll(0, bytes);
    final settings = utf8.encode(jsonEncode(options));
    final settingsPointer = copy(settings);
    final manifest = index ?? Uint8List(0);
    final manifestPointer = copy(manifest);
    final pin = utf8.encode(sha256 ?? '');
    final pinPointer = copy(pin);
    if (location is int) {
      return _call(
        (out) => _openDescriptor(
          location,
          manifestPointer,
          manifest.length,
          pinPointer,
          pin.length,
          settingsPointer,
          settings.length,
          out,
        ),
      );
    }
    final path = utf8.encode(location as String);
    final pointer = copy(path);
    return _call(
      (out) => handle == null
          ? _openFile(
              pointer,
              path.length,
              manifestPointer,
              manifest.length,
              pinPointer,
              pin.length,
              settingsPointer,
              settings.length,
              out,
            )
          : _appendFile(
              handle,
              pointer,
              path.length,
              settingsPointer,
              settings.length,
              out,
            ),
    );
  });
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

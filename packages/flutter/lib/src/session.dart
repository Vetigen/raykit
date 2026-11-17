import 'dart:async';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'native.dart' as native;

typedef Json = Map<String, Object?>;

final class RayKitException implements Exception {
  const RayKitException(this.code, [this.detail]);
  final String code;
  final String? detail;
  @override
  String toString() => detail == null ? code : '$code: $detail';
}

final class RayKitCancellation {
  final _cancellation = Completer<void>();
  bool get isCancelled => _cancellation.isCompleted;
  Future<void> get cancelled => _cancellation.future;
  void cancel() {
    if (!isCancelled) _cancellation.complete();
  }

  void check() {
    if (isCancelled) throw const RayKitException('cancelled');
  }
}

sealed class RayKitSource {
  const RayKitSource();
  const factory RayKitSource.bytes(Uint8List bytes) = _ByteSource;
  const factory RayKitSource.file(File file) = _FileSource;
  const factory RayKitSource.indexedFile(File file, RayKitFrameIndex index) =
      _IndexedFileSource;

  /// Keep the borrowed descriptor open until `RayKitSession.open` returns.
  /// RayKit owns its duplicate. Close the session when the host revokes access.
  const factory RayKitSource.descriptor(int fd, {RayKitFrameIndex? index}) =
      _DescriptorSource;
  const factory RayKitSource.reader(
    Stream<Uint8List> Function(RayKitCancellation) read,
  ) = _ReaderSource;
  const factory RayKitSource.attached(RayKitSession session) = _AttachedSource;
  RayKitSession? get attachedSession => null;
  Future<Uint8List> read(RayKitCancellation cancellation, int limit);
}

final class _AttachedSource extends RayKitSource {
  const _AttachedSource(this.attachedSession);
  @override
  final RayKitSession attachedSession;

  @override
  Future<Uint8List> read(RayKitCancellation cancellation, int limit) async =>
      throw const RayKitException(
        'invalid_request',
        'Attach a panel to the verified session',
      );
}

final class RayKitFrameIndex {
  const RayKitFrameIndex(this.bytes, {required this.sha256});
  final Uint8List bytes;

  /// Pin obtained from a trusted publisher or a previously validated open.
  final String sha256;
}

final class _IndexedFileSource extends RayKitSource {
  const _IndexedFileSource(this.file, this.index);
  final File file;
  final RayKitFrameIndex index;
  @override
  Future<Uint8List> read(RayKitCancellation cancellation, int limit) async =>
      throw const RayKitException('invalid_request', 'Use an indexed session');
}

final class _DescriptorSource extends RayKitSource {
  const _DescriptorSource(this.fd, {this.index});
  final int fd;
  final RayKitFrameIndex? index;
  @override
  Future<Uint8List> read(RayKitCancellation cancellation, int limit) async =>
      throw const RayKitException(
        'invalid_request',
        'Use a descriptor session',
      );
}

final class _ByteSource extends RayKitSource {
  const _ByteSource(this.bytes);
  final Uint8List bytes;
  @override
  Future<Uint8List> read(RayKitCancellation cancellation, int limit) async {
    cancellation.check();
    if (bytes.length > limit) {
      throw const RayKitException('limit', 'Source bytes');
    }
    return bytes;
  }
}

final class _FileSource extends RayKitSource {
  const _FileSource(this.file);
  final File file;
  @override
  Future<Uint8List> read(RayKitCancellation cancellation, int limit) async {
    cancellation.check();
    if (await file.length() > limit) {
      throw const RayKitException('limit', 'Source bytes');
    }
    return _collect(file.openRead(), cancellation, limit);
  }
}

final class _ReaderSource extends RayKitSource {
  const _ReaderSource(this.loader);
  final Stream<Uint8List> Function(RayKitCancellation) loader;
  @override
  Future<Uint8List> read(RayKitCancellation cancellation, int limit) =>
      _collect(loader(cancellation), cancellation, limit);
}

Future<Uint8List> _collect(
  Stream<List<int>> stream,
  RayKitCancellation cancellation,
  int limit,
) async {
  final bytes = BytesBuilder();
  final reader = StreamIterator(stream);
  try {
    while (await _abortable(reader.moveNext(), cancellation)) {
      final chunk = reader.current;
      if (bytes.length + chunk.length > limit) {
        throw const RayKitException('limit', 'Source bytes');
      }
      bytes.add(chunk);
    }
    return bytes.takeBytes();
  } finally {
    await reader.cancel();
  }
}

Future<T> _abortable<T>(Future<T> future, RayKitCancellation cancellation) =>
    Future.any([
      future,
      cancellation.cancelled.then<T>(
        (_) => throw const RayKitException('cancelled'),
      ),
    ]);

final class RayKitOpenOptions {
  const RayKitOpenOptions({
    this.limits = const {},
    this.expectedSize,
    this.expectedSha256,
    this.expectedInstanceUid,
    this.expectedSeriesUid,
    this.expectedStudyUid,
    this.revision,
  });
  final Map<String, int> limits;
  final int? expectedSize;
  final String? expectedSha256;
  final String? expectedInstanceUid;
  final String? expectedSeriesUid;
  final String? expectedStudyUid;
  final String? revision;
  Json toJson() => {
    'limits': limits,
    'expected_size': expectedSize,
    'expected_sha256': expectedSha256,
    'expected_instance_uid': expectedInstanceUid,
    'expected_series_uid': expectedSeriesUid,
    'expected_study_uid': expectedStudyUid,
  };
}

final class RayKitInspection {
  RayKitInspection(Json data) : data = Map.unmodifiable(data);
  final Json data;
  int get frames => data['frames'] as int;
  String get contentSha256 => data['content_sha256'] as String;
  String get instanceUid => data['instance_uid'] as String;
  String get object => data['object'] as String;
  String? get seriesDescription => data['series_description'] as String?;
  Json get capabilities => Map.unmodifiable(data['capabilities'] as Json);
  List<double>? get frameDurations => (data['frame_durations_ms'] as List?)
      ?.map((n) => (n as num).toDouble())
      .toList();
}

final class RayKitFrame {
  RayKitFrame(this.data, this.pixels, this.requestId);
  final Json data;
  final Uint8List pixels;
  final int requestId;
  Json get source => data['source'] as Json;
  Json get geometry => data['geometry'] as Json;
  Json? get display => data['display'] as Json?;
  List<Json> get views => (data['views'] as List? ?? []).cast<Json>();
  String? get modalityUnit => data['modality_unit'] as String?;
  Json? get quantitativeScale => data['quantitative_scale'] as Json?;
  int get index => source['frame'] as int;
  int get columns => (data['format'] as Json)['columns'] as int;
  int get rows => (data['format'] as Json)['rows'] as int;
  String get encoding => data['encoding'] as String;

  Json? selectedView(Object? choice) {
    if (choice is! Json) return null;
    for (final entry in views) {
      final selection = entry['selection'] as Json;
      if (selection['kind'] == choice['kind'] &&
          selection['index'] == choice['index']) {
        return entry;
      }
    }
    return null;
  }
}

final class RayKitSession {
  RayKitSession._(this._channel, this.inspection, this.revision);
  final _Channel _channel;
  final RayKitInspection inspection;
  final String revision;
  bool get isClosed => _channel._closing;
  int _owners = 1;
  bool _ownerReleased = false;
  final _revocations = StreamController<void>.broadcast(sync: true);
  Stream<void> get revocations => _revocations.stream;
  Future<void> _planeQueue = Future.value();
  int _planeTicket = 0;

  static Future<RayKitSession> open(
    RayKitSource source, {
    RayKitOpenOptions options = const RayKitOpenOptions(),
    RayKitCancellation? cancellation,
  }) async {
    final scope = cancellation ?? RayKitCancellation();
    final limit = options.limits['source_bytes'] ?? 192 * 1024 * 1024;
    if (limit < 0 || limit > 192 * 1024 * 1024) {
      throw const RayKitException('limit', 'Source limit');
    }
    scope.check();
    final local = switch (source) {
      _FileSource(:final file) => (location: file.path, index: null),
      _IndexedFileSource(:final file, :final index) => (
        location: file.path,
        index: index,
      ),
      _DescriptorSource(:final fd, :final index) => (
        location: fd,
        index: index,
      ),
      _ => null,
    };
    final Uint8List? bytes;
    try {
      bytes = local == null
          ? await _abortable(source.read(scope, limit), scope)
          : null;
    } on RayKitException {
      rethrow;
    } catch (_) {
      throw const RayKitException('io', 'Source read failed');
    }
    scope.check();
    final channel = await _Channel.start();
    try {
      scope.check();
      final reply = local != null
          ? await _sendLocal(
              channel,
              'open_file',
              local.location,
              options.toJson(),
              scope,
              local.index,
            )
          : await channel.send('open', [
              TransferableTypedData.fromList([bytes!]),
              options.toJson(),
            ], scope);
      scope.check();
      final info = RayKitInspection(reply.metadata as Json);
      return RayKitSession._(
        channel,
        info,
        options.revision ?? info.contentSha256,
      );
    } catch (_) {
      await channel.close();
      rethrow;
    }
  }

  static Future<_Reply> _sendLocal(
    _Channel channel,
    String op,
    Object location,
    Json options,
    RayKitCancellation token, [
    RayKitFrameIndex? index,
  ]) {
    if (index != null &&
        (index.bytes.length > 8 * 1024 * 1024 || index.sha256.length != 64)) {
      throw const RayKitException(
        'integrity',
        'Frame index size or SHA-256 pin',
      );
    }
    if (location is int && (location < 0 || location > 0x7fffffff)) {
      throw const RayKitException('invalid_request', 'File descriptor');
    }
    return channel.send(op, [
      location,
      options,
      index == null ? null : TransferableTypedData.fromList([index.bytes]),
      index?.sha256,
    ], token);
  }

  Future<RayKitFrameIndex> createFrameIndex({
    RayKitCancellation? cancellation,
  }) async {
    final reply = await _command({'op': 'create_frame_index'}, cancellation);
    return RayKitFrameIndex(
      reply.bytes!,
      sha256: (reply.metadata as Json)['sha256'] as String,
    );
  }

  static Future<RayKitInspection> inspect(
    RayKitSource source, {
    RayKitOpenOptions options = const RayKitOpenOptions(),
    RayKitCancellation? cancellation,
  }) async {
    final session = await open(
      source,
      options: options,
      cancellation: cancellation,
    );
    try {
      return session.inspection;
    } finally {
      await session.close();
    }
  }

  static Future<Json> capabilities() async {
    final channel = await _Channel.start();
    try {
      return (await channel.send('capabilities', null, null)).metadata as Json;
    } finally {
      await channel.close();
    }
  }

  Future<RayKitFrame> readFrame(
    int index, {
    bool stored = true,
    Json render = const {},
    bool texture16 = false,
    bool fallbackVoi = false,
    RayKitCancellation? cancellation,
  }) async {
    final reply = await _command({
      'op': 'frame',
      'index': index,
      'output': texture16 ? 'texture16' : (stored ? 'stored' : 'rgba'),
      'options': render,
      'fallback_voi': fallbackVoi,
    }, cancellation);
    final frame = RayKitFrame(reply.metadata as Json, reply.bytes!, reply.id);
    if (frame.index != index ||
        frame.source['content_sha256'] != inspection.contentSha256) {
      throw const RayKitException(
        'integrity',
        'Frame reply does not match source and index',
      );
    }
    return frame;
  }

  Future<Uint8List> render(
    int index,
    Json options, {
    RayKitCancellation? cancellation,
  }) async => (await _command({
    'op': 'render',
    'index': index,
    'options': options,
  }, cancellation)).bytes!;

  Future<List<Json>> views(int index) async =>
      ((await _command({'op': 'views', 'index': index}, null)).metadata as List)
          .cast<Json>();

  Future<Json> frameInfo(int index) =>
      _json({'op': 'frame_info', 'index': index}, null);

  Future<Json?> locatePatient(
    List<num> point,
    String reference,
    List<num> normal,
  ) async =>
      (await _command({
            'op': 'locate_patient',
            'point': point,
            'reference': reference,
            'normal': normal,
          }, null)).metadata
          as Json?;

  Future<Json> sampleAt(int index, int x, int y) =>
      _json({'op': 'sample_at', 'index': index, 'x': x, 'y': y}, null);

  Future<Json> sample(
    int index,
    int x,
    int y, {
    RayKitCancellation? cancellation,
  }) => _json({'op': 'sample', 'index': index, 'x': x, 'y': y}, cancellation);

  Future<Json> transform(
    int index,
    Json view, {
    Json? screenPoint,
    RayKitCancellation? cancellation,
  }) => _json({
    'op': 'transform',
    'index': index,
    'view': view,
    'point': screenPoint,
  }, cancellation);

  Future<Json> measure(
    int index,
    Json request, {
    RayKitCancellation? cancellation,
  }) => _json({
    'op': 'measure',
    'index': index,
    'request': request,
  }, cancellation);

  Future<Json> reopenMeasurement(
    Json record, {
    RayKitCancellation? cancellation,
  }) => _json({'op': 'reopen', 'record': record}, cancellation);

  Future<Json> stats() => _json({'op': 'stats'}, null);

  Future<Json> addVolumeSource(
    RayKitSource source, {
    RayKitOpenOptions options = const RayKitOpenOptions(),
    RayKitCancellation? cancellation,
  }) async => (await _append(source, options, cancellation)).metadata as Json;

  Future<Json> importSr(
    RayKitSource source, {
    String? expectedSourceSha256,
    RayKitCancellation? cancellation,
  }) async =>
      (await _append(source, const RayKitOpenOptions(), cancellation, {
            'kind': 'sr',
            'expected_source_sha256': expectedSourceSha256,
          })).metadata
          as Json;

  Future<Uint8List> exportSr(
    Json record,
    Json options, {
    RayKitCancellation? cancellation,
  }) async => (await _command({
    'op': 'export_sr',
    'record': record,
    'options': options,
  }, cancellation)).bytes!;

  Future<({Json geometry, Uint8List mask})> segmentation(
    RayKitSource source,
    int frame,
    int segment, {
    RayKitCancellation? cancellation,
  }) async {
    final reply = await _append(
      source,
      const RayKitOpenOptions(),
      cancellation,
      {'kind': 'segmentation', 'frame': frame, 'segment': segment},
    );
    return (geometry: reply.metadata as Json, mask: reply.bytes!);
  }

  Future<Json> presentation(
    RayKitSource source,
    int frame, {
    RayKitCancellation? cancellation,
  }) async =>
      (await _append(source, const RayKitOpenOptions(), cancellation, {
            'kind': 'presentation',
            'frame': frame,
          })).metadata
          as Json;

  Future<_Reply> _append(
    RayKitSource source,
    RayKitOpenOptions options,
    RayKitCancellation? cancellation, [
    Json? attachment,
  ]) async {
    final token = cancellation ?? RayKitCancellation();
    final limit = options.limits['source_bytes'] ?? 192 * 1024 * 1024;
    if (limit < 0 || limit > 192 * 1024 * 1024) {
      throw const RayKitException('limit', 'Source limit');
    }
    final ceiling = attachment == null
        ? limit
        : limit.clamp(0, 64 * 1024 * 1024);
    if (source case _FileSource(:final file)) {
      return _sendLocal(_channel, 'append_file', file.path, {
        ...options.toJson(),
        'attachment': attachment,
      }, token);
    }
    final bytes = await _abortable(source.read(token, ceiling), token);
    return _channel.send('append', [
      TransferableTypedData.fromList([bytes]),
      {...options.toJson(), 'attachment': attachment},
    ], token);
  }

  Future<Json> volumeCandidates({RayKitCancellation? cancellation}) =>
      _json({'op': 'volume_candidates'}, cancellation);

  Future<Json> buildVolume(
    int index,
    int revision, {
    RayKitCancellation? cancellation,
  }) => _json({
    'op': 'volume_build',
    'index': index,
    'revision': revision,
  }, cancellation);

  Future<double?> sampleVolume(
    List<double> patientPoint, {
    RayKitCancellation? cancellation,
  }) async =>
      ((await _command({
                'op': 'volume_sample',
                'point': patientPoint,
              }, cancellation)).metadata
              as num?)
          ?.toDouble();

  Future<({Json geometry, Uint8List pixels})> reslice(
    Json plane, {
    Json? window,
    String sampling = 'trilinear',
    bool invert = false,
    String palette = 'gray',
    RayKitCancellation? cancellation,
  }) async {
    final ticket = _planeTicket = (_planeTicket + 1) & 0xffffffff;
    final work = _planeQueue.then((_) async {
      cancellation?.check();
      try {
        var reply = await _command({
          'op': 'reslice_start',
          'ticket': ticket,
          'plane': plane,
          'window': window,
          'sampling': sampling,
          'invert': invert,
          'palette': palette,
        }, cancellation);
        while (reply.metadata == null) {
          reply = await _command({
            'op': 'reslice_step',
            'ticket': ticket,
          }, cancellation);
        }
        return (geometry: reply.metadata as Json, pixels: reply.bytes!);
      } finally {
        if (cancellation?.isCancelled ?? false) {
          try {
            await _command({'op': 'reslice_cancel', 'ticket': ticket}, null);
          } on RayKitException catch (
            _
          ) {} // The session may already have closed.
        }
      }
    });
    _planeQueue = work.then<void>((_) {}, onError: (Object _) {});
    return cancellation == null ? work : _abortable(work, cancellation);
  }

  Future<void> evict() async {
    await _command({'op': 'evict'}, null);
  }

  Future<void> prefetch(int index, {RayKitCancellation? cancellation}) async {
    await _command({'op': 'prefetch', 'index': index}, cancellation);
  }

  Future<Uint8List> document({RayKitCancellation? cancellation}) async =>
      (await _command({'op': 'document'}, cancellation)).bytes!;
  Future<void> Function() retain() {
    if (isClosed) throw const RayKitException('closed');
    _owners++;
    var released = false;
    return () async {
      if (released) return;
      released = true;
      await _release();
    };
  }

  Future<void> _release() async {
    if (!isClosed && --_owners == 0) await revoke();
  }

  Future<void> close() async {
    if (_ownerReleased) return;
    _ownerReleased = true;
    await _release();
  }

  Future<void> revoke() async {
    final closing = _channel.close();
    if (!_revocations.isClosed) {
      _revocations.add(null);
      unawaited(_revocations.close());
    }
    await closing;
  }

  Future<_Reply> _command(Json command, RayKitCancellation? cancellation) =>
      _channel.send('request', command, cancellation);
  Future<Json> _json(Json command, RayKitCancellation? cancellation) async =>
      (await _command(command, cancellation)).metadata as Json;
}

typedef _Reply = ({int id, Object? metadata, Uint8List? bytes});
typedef _Pending = ({
  int id,
  String op,
  Object? data,
  Completer<_Reply> done,
  RayKitCancellation? token,
});

final class _Channel {
  _Channel(this._messages, this._exited);
  final ReceivePort _messages;
  final ReceivePort _exited;
  final _ready = Completer<SendPort>();
  final _stopped = Completer<void>();
  final _queue = <_Pending>[];
  _Pending? _active;
  SendPort? _send;
  bool _closing = false;
  int _nextId = 1;

  static Future<_Channel> start() async {
    final channel = _Channel(ReceivePort(), ReceivePort());
    channel._messages.listen(channel._reply);
    channel._exited.listen((_) => channel._finish());
    try {
      await Isolate.spawn(
        _worker,
        channel._messages.sendPort,
        onExit: channel._exited.sendPort,
        onError: channel._exited.sendPort,
        debugName: 'RayKit',
      );
      channel._send = await channel._ready.future;
      return channel;
    } catch (_) {
      channel._finish();
      throw const RayKitException('internal', 'Native worker could not start');
    }
  }

  Future<_Reply> send(String op, Object? data, RayKitCancellation? token) {
    if (_closing) return Future.error(const RayKitException('closed'));
    if (token?.isCancelled ?? false) {
      return Future.error(const RayKitException('cancelled'));
    }
    if (_queue.length >= 64) {
      return Future.error(
        const RayKitException('limit', 'Pending native requests'),
      );
    }
    final pending = (
      id: _nextId++,
      op: op,
      data: data,
      done: Completer<_Reply>(),
      token: token,
    );
    _queue.add(pending);
    _pump();
    if (token == null) return pending.done.future;
    return _abortable(pending.done.future, token);
  }

  void _pump() {
    if (_active != null || _closing) return;
    while (_queue.isNotEmpty) {
      final pending = _queue.removeAt(0);
      if (pending.token?.isCancelled ?? false) {
        pending.done.completeError(const RayKitException('cancelled'));
        continue;
      }
      _active = pending;
      _send!.send([pending.id, pending.op, pending.data]);
      return;
    }
  }

  void _reply(Object? event) {
    if (event is SendPort) {
      _ready.complete(event);
      return;
    }
    if (event is! List || _active == null || _active!.id != event[0]) return;
    final pending = _active!;
    _active = null;
    if (!pending.done.isCompleted) {
      if (event[1] == 0) {
        final bytes = event[3] as TransferableTypedData?;
        pending.done.complete((
          id: pending.id,
          metadata: event[2],
          bytes: bytes?.materialize().asUint8List(),
        ));
      } else {
        final error = event[2] as Json?;
        pending.done.completeError(
          RayKitException(
            error?['code'] as String? ?? 'internal',
            error?['detail'] as String?,
          ),
        );
      }
    }
    _pump();
  }

  Future<void> close() {
    if (!_closing) {
      _closing = true;
      _reject();
      _send?.send([0, 'close', null]);
    }
    return _stopped.future;
  }

  void _reject() {
    for (final pending in [_active, ..._queue]) {
      if (pending != null && !pending.done.isCompleted) {
        pending.done.completeError(const RayKitException('closed'));
      }
    }
    _queue.clear();
  }

  void _finish() {
    if (_stopped.isCompleted) return;
    _closing = true;
    _reject();
    if (!_ready.isCompleted) {
      _ready.completeError(
        const RayKitException('internal', 'Native worker exited'),
      );
    }
    _messages.close();
    _exited.close();
    _stopped.complete();
  }
}

Future<void> _worker(SendPort parent) async {
  final mailbox = ReceivePort();
  parent.send(mailbox.sendPort);
  var handle = 0;
  var inputCopies = 0;
  var outputCopies = 0;
  try {
    await for (final List message in mailbox) {
      final id = message[0];
      final op = message[1];
      if (op == 'close') return;
      try {
        if (native.abiVersion() != 1) {
          throw const RayKitException('unsupported', 'Native ABI version');
        }
        final native.NativeReply reply;
        if (op == 'open' || op == 'append') {
          final options = message[2] as List;
          final bytes = (options[0] as TransferableTypedData)
              .materialize()
              .asUint8List();
          inputCopies += bytes.length * 3;
          reply = native.openNative(
            bytes,
            options[1] as Json,
            handle: op == 'append' ? handle : null,
          );
          if (op == 'open') handle = reply.handle;
        } else if (op == 'open_file' || op == 'append_file') {
          final values = message[2] as List;
          final index = (values[2] as TransferableTypedData?)
              ?.materialize()
              .asUint8List();
          reply = native.openLocal(
            values[0] as Object,
            values[1] as Json,
            handle: op == 'append_file' ? handle : null,
            index: index,
            sha256: values[3] as String?,
          );
          if (op == 'open_file') handle = reply.handle;
        } else if (op == 'capabilities') {
          reply = native.capabilitiesNative();
        } else {
          reply = native.requestNative(handle, message[2] as Json);
        }
        outputCopies += reply.byteLength;
        final metadata = reply.metadata;
        if (metadata is Json &&
            message[2] is Json &&
            (message[2] as Json)['op'] == 'stats') {
          metadata['native_input_copy_bytes'] = inputCopies;
          metadata['native_output_copy_bytes'] = outputCopies;
        }
        parent.send([id, reply.status, metadata, reply.bytes]);
      } on RayKitException catch (error) {
        parent.send([
          id,
          1,
          {'code': error.code, 'detail': error.detail},
          null,
        ]);
      } catch (_) {
        parent.send([
          id,
          1,
          {'code': 'internal', 'detail': 'Native operation failed'},
          null,
        ]);
      }
    }
  } finally {
    if (handle != 0) native.closeHandle(handle);
    mailbox.close();
  }
}

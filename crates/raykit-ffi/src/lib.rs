use std::{
    collections::HashMap,
    panic::{AssertUnwindSafe, catch_unwind},
    ptr, slice,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

use raykit_core::{Error, Limits, MAX_FRAME_INDEX_BYTES, NativeFile, Result};
use raykit_protocol::{
    ABI_VERSION, BoundSession, MAX_COMMAND_BYTES, OpenOptions, Reply, error_json,
};

#[repr(C)]
pub struct RaykitBuffer {
    data: *mut u8,
    len: usize,
}

impl From<Vec<u8>> for RaykitBuffer {
    fn from(bytes: Vec<u8>) -> Self {
        if bytes.is_empty() {
            return Self {
                data: ptr::null_mut(),
                len: 0,
            };
        }
        let boxed = bytes.into_boxed_slice();
        let len = boxed.len();
        LIVE_BUFFERS.fetch_add(1, Ordering::Relaxed);
        Self {
            data: Box::into_raw(boxed).cast(),
            len,
        }
    }
}

#[repr(C)]
pub struct RaykitResponse {
    handle: u64,
    metadata: RaykitBuffer,
    data: RaykitBuffer,
}

struct Handle {
    closed: AtomicBool,
    session: Mutex<BoundSession>,
}

struct Registry {
    next: u64,
    handles: HashMap<u64, Arc<Handle>>,
}

static HANDLES: OnceLock<Mutex<Registry>> = OnceLock::new();
static LIVE_BUFFERS: AtomicUsize = AtomicUsize::new(0);

fn handles() -> &'static Mutex<Registry> {
    HANDLES.get_or_init(|| {
        Mutex::new(Registry {
            next: 1,
            handles: HashMap::new(),
        })
    })
}

fn register((session, reply): (BoundSession, Reply)) -> Result<(u64, Reply)> {
    let mut registry = handles().lock().map_err(|_| Error::Internal)?;
    if registry.handles.len() >= 16 {
        return Err(Error::Limit("native session count"));
    }
    let id = registry.next;
    registry.next = id.checked_add(1).ok_or(Error::Internal)?;
    registry.handles.insert(
        id,
        Arc::new(Handle {
            closed: AtomicBool::new(false),
            session: Mutex::new(session),
        }),
    );
    Ok((id, reply))
}

fn with_session(
    id: u64,
    action: impl FnOnce(&mut BoundSession) -> Result<Reply>,
) -> Result<(u64, Reply)> {
    let handle = handles()
        .lock()
        .map_err(|_| Error::Internal)?
        .handles
        .get(&id)
        .cloned()
        .ok_or(Error::Closed)?;
    let mut session = handle.session.lock().map_err(|_| Error::Internal)?;
    if handle.closed.load(Ordering::Acquire) {
        return Err(Error::Closed);
    }
    let reply = action(&mut session)?;
    if handle.closed.load(Ordering::Acquire) {
        return Err(Error::Closed);
    }
    Ok((0, reply))
}

fn guard(out: *mut RaykitResponse, operation: impl FnOnce() -> Result<(u64, Reply)>) -> u32 {
    if out.is_null() {
        return 2;
    }
    let (code, handle, metadata, data) = match catch_unwind(AssertUnwindSafe(operation)) {
        Ok(Ok((id, reply))) => (0, id, reply.metadata, reply.data),
        Ok(Err(error)) => (1, 0, error_json(&error), Vec::new()),
        Err(_) => (1, 0, error_json(&Error::Internal), Vec::new()),
    };
    let values = RaykitResponse {
        handle,
        metadata: metadata.into_bytes().into(),
        data: data.into(),
    };
    // The ABI requires an aligned destination writable for one response.
    unsafe { out.write(values) };
    code
}

unsafe fn input<'a>(data: *const u8, len: usize, max: usize) -> Result<&'a [u8]> {
    if len > max {
        return Err(Error::Limit("ABI input bytes"));
    }
    if len == 0 {
        return Ok(&[]);
    }
    if data.is_null() {
        return Err(Error::InvalidRequest("null ABI input"));
    }
    // The caller lends a readable, immutable allocation for the duration of the call.
    Ok(unsafe { slice::from_raw_parts(data, len) })
}

#[unsafe(no_mangle)]
pub extern "C" fn raykit_v1_abi_version() -> u32 {
    ABI_VERSION
}

/// # Safety
/// `out` must be null or aligned and writable for a response.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn raykit_v1_capabilities(out: *mut RaykitResponse) -> u32 {
    guard(out, || Ok((0, raykit_protocol::capabilities()?)))
}

/// # Safety
/// Input pointers must remain readable for their lengths. `out` must be null or a separate writable response.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn raykit_v1_open(
    bytes: *const u8,
    len: usize,
    options: *const u8,
    options_len: usize,
    out: *mut RaykitResponse,
) -> u32 {
    guard(out, || {
        let options =
            OpenOptions::parse(unsafe { input(options, options_len, MAX_COMMAND_BYTES)? })?;
        let source = unsafe {
            input(
                bytes,
                len,
                options
                    .limits
                    .source_bytes
                    .min(Limits::default().source_bytes),
            )?
        };
        register(BoundSession::open(source.to_vec(), options)?)
    })
}

fn file_source(path: &[u8]) -> Result<NativeFile> {
    let path =
        std::str::from_utf8(path).map_err(|_| Error::InvalidRequest("file path is not UTF-8"))?;
    NativeFile::open(std::path::Path::new(path))
}

fn file_index<'a>(manifest: &'a [u8], pin: &'a [u8]) -> Result<Option<(&'a [u8], &'a str)>> {
    if manifest.is_empty() && pin.is_empty() {
        return Ok(None);
    }
    let pin = std::str::from_utf8(pin).map_err(|_| Error::InvalidRequest("frame index SHA-256"))?;
    Ok(Some((manifest, pin)))
}

/// # Safety
/// Input spans must be readable and `out` must be null or separate and writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn raykit_v1_open_file(
    path: *const u8,
    path_len: usize,
    manifest: *const u8,
    manifest_len: usize,
    pin: *const u8,
    pin_len: usize,
    options: *const u8,
    options_len: usize,
    out: *mut RaykitResponse,
) -> u32 {
    guard(out, || {
        let options =
            OpenOptions::parse(unsafe { input(options, options_len, MAX_COMMAND_BYTES)? })?;
        let source = file_source(unsafe { input(path, path_len, 4096)? })?;
        let index = file_index(
            unsafe { input(manifest, manifest_len, MAX_FRAME_INDEX_BYTES)? },
            unsafe { input(pin, pin_len, 64)? },
        )?;
        register(BoundSession::open_file(source, index, options)?)
    })
}

/// # Safety
/// The caller keeps the Unix descriptor open through the call. Input spans must be
/// readable and `out` must be null or separate and writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn raykit_v1_open_descriptor(
    fd: i32,
    manifest: *const u8,
    manifest_len: usize,
    pin: *const u8,
    pin_len: usize,
    options: *const u8,
    options_len: usize,
    out: *mut RaykitResponse,
) -> u32 {
    guard(out, || {
        #[cfg(unix)]
        let source = NativeFile::duplicate_descriptor(fd)?;
        #[cfg(not(unix))]
        let source: NativeFile = {
            let _ = fd;
            Err(Error::Unsupported("Unix file descriptor"))?
        };
        let options =
            OpenOptions::parse(unsafe { input(options, options_len, MAX_COMMAND_BYTES)? })?;
        let index = file_index(
            unsafe { input(manifest, manifest_len, MAX_FRAME_INDEX_BYTES)? },
            unsafe { input(pin, pin_len, 64)? },
        )?;
        register(BoundSession::open_file(source, index, options)?)
    })
}

/// # Safety
/// Input spans must be readable and `out` must be null or separate and writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn raykit_v1_append_file(
    id: u64,
    path: *const u8,
    path_len: usize,
    options: *const u8,
    options_len: usize,
    out: *mut RaykitResponse,
) -> u32 {
    guard(out, || {
        let options =
            OpenOptions::parse(unsafe { input(options, options_len, MAX_COMMAND_BYTES)? })?;
        let file = file_source(unsafe { input(path, path_len, 4096)? })?;
        with_session(id, |session| session.append_file(file, options))
    })
}

/// # Safety
/// Inputs must be readable for their lengths. `out` must be null or a separate writable response.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn raykit_v1_append(
    id: u64,
    bytes: *const u8,
    len: usize,
    options: *const u8,
    options_len: usize,
    out: *mut RaykitResponse,
) -> u32 {
    guard(out, || {
        let options =
            OpenOptions::parse(unsafe { input(options, options_len, MAX_COMMAND_BYTES)? })?;
        let source = unsafe {
            input(
                bytes,
                len,
                options
                    .limits
                    .source_bytes
                    .min(Limits::default().source_bytes),
            )?
        };
        with_session(id, |session| session.append(source.to_vec(), options))
    })
}

/// # Safety
/// Input pointer must remain readable for its length. `out` must be null or a separate writable response.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn raykit_v1_request(
    id: u64,
    command: *const u8,
    len: usize,
    out: *mut RaykitResponse,
) -> u32 {
    guard(out, || {
        let bytes = unsafe { input(command, len, MAX_COMMAND_BYTES)? };
        with_session(id, |session| session.request(bytes))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn raykit_v1_close(id: u64) {
    if let Ok(mut registry) = handles().lock()
        && let Some(handle) = registry.handles.remove(&id)
    {
        handle.closed.store(true, Ordering::Release);
    }
}

/// # Safety
/// The buffer must come from a RayKit response and must only be released once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn raykit_v1_free(data: *mut u8, len: usize) {
    if !data.is_null() {
        // The pointer and length reconstruct the boxed slice from the response.
        unsafe { drop(Box::from_raw(ptr::slice_from_raw_parts_mut(data, len))) };
        LIVE_BUFFERS.fetch_sub(1, Ordering::Relaxed);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn raykit_v1_live_sessions() -> usize {
    handles()
        .lock()
        .map_or(0, |registry| registry.handles.len())
}

#[unsafe(no_mangle)]
pub extern "C" fn raykit_v1_live_buffers() -> usize {
    LIVE_BUFFERS.load(Ordering::Relaxed)
}

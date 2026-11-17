use std::{
    alloc::{GlobalAlloc, Layout, System},
    env, fs,
    sync::atomic::{AtomicUsize, Ordering::Relaxed},
    time::Instant,
};

use raykit_core::{Limits, Session};
use serde_json::json;

struct MeasuredAllocator;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

fn record_add(bytes: usize) {
    let current = LIVE.fetch_add(bytes, Relaxed) + bytes;
    PEAK.fetch_max(current, Relaxed);
}

// The example runs decoder operations serially and counts requested allocation sizes.
unsafe impl GlobalAlloc for MeasuredAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            record_add(layout.size());
        }
        pointer
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size(), Relaxed);
        unsafe { System.dealloc(ptr, layout) };
    }

    unsafe fn realloc(&self, ptr: *mut u8, old: Layout, size: usize) -> *mut u8 {
        let pointer = unsafe { System.realloc(ptr, old, size) };
        if !pointer.is_null() {
            if size > old.size() {
                record_add(size - old.size());
            } else {
                LIVE.fetch_sub(old.size() - size, Relaxed);
            }
        }
        pointer
    }
}

#[global_allocator]
static ALLOCATOR: MeasuredAllocator = MeasuredAllocator;

fn observe<T>(operation: impl FnOnce() -> T) -> (T, serde_json::Value) {
    let before = LIVE.load(Relaxed);
    PEAK.store(before, Relaxed);
    let start = Instant::now();
    let result = operation();
    let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
    let after = LIVE.load(Relaxed);
    let peak = PEAK.load(Relaxed);
    (
        result,
        json!({
            "milliseconds": elapsed_ms,
            "peak_additional_bytes": peak.saturating_sub(before),
            "retained_additional_bytes": (after as i64) - (before as i64),
            "transient_above_retained_bytes": peak.saturating_sub(after.max(before)),
        }),
    )
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    for file in env::args().skip(1) {
        let payload = fs::read(&file)?;
        let (session, parse) = observe(|| Session::open(payload, Limits::default()));
        let mut session = session?;
        let count = session.inspection().frames;
        let mut frames = Vec::new();
        for index in [0, count / 2, count - 1] {
            session.evict_frames();
            let (frame, allocations) = observe(|| session.read_frame(index));
            let frame = frame?;
            frames.push(json!({
                "index": index, "sample_at_0_0": frame.sample(0, 0)?,
                "allocation": allocations, "memory": session.memory(),
            }));
        }
        println!(
            "{}",
            json!({ "file": std::path::Path::new(&file).file_name().unwrap_or_default().to_string_lossy(),
                "syntax": session.inspection().transfer_syntax, "parse_and_index": parse, "frames": frames })
        );
    }
    Ok(())
}

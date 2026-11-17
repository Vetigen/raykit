use std::{
    fs::{File, OpenOptions},
    path::Path,
    sync::Mutex,
    time::SystemTime,
};

use crate::{Error, Result};

#[derive(PartialEq, Eq)]
struct FileState {
    bytes: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    changed: (i64, i64),
}

impl FileState {
    fn read(file: &File) -> Result<Self> {
        let stat = file.metadata().map_err(|_| Error::Io("file metadata"))?;
        if !stat.is_file() {
            return Err(Error::Io("source requires a regular file"));
        }
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            bytes: stat.len(),
            modified: stat.modified().ok(),
            #[cfg(unix)]
            changed: (stat.ctime(), stat.ctime_nsec()),
        })
    }
}

/// Keeps one open file description for the entire reading lifetime.
pub struct NativeFile {
    file: Mutex<File>,
    state: FileState,
}

impl NativeFile {
    pub fn open(path: &Path) -> Result<Self> {
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // A path replacement with a FIFO must not block the source isolate.
            options.custom_flags(libc::O_NONBLOCK);
        }
        Self::from_file(
            options
                .open(path)
                .map_err(|_| Error::Io("open source file"))?,
        )
    }

    pub fn from_file(file: File) -> Result<Self> {
        let state = FileState::read(&file)?;
        Ok(Self {
            file: Mutex::new(file),
            state,
        })
    }

    #[cfg(unix)]
    pub fn duplicate_descriptor(fd: i32) -> Result<Self> {
        use std::os::fd::FromRawFd;
        // fcntl atomically validates and duplicates the borrowed descriptor.
        let owned = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
        if owned < 0 {
            return Err(Error::Io("duplicate source descriptor"));
        }
        Self::from_file(unsafe { File::from_raw_fd(owned) })
    }

    pub fn len(&self) -> u64 {
        self.state.bytes
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn read(&self, start: usize, len: usize) -> Result<Vec<u8>> {
        if (start as u64).saturating_add(len as u64) > self.len() {
            return Err(Error::Integrity("file range outside source"));
        }
        let file = self.file.lock().map_err(|_| Error::Internal)?;
        if FileState::read(&file)? != self.state {
            return Err(Error::Integrity("source file changed"));
        }
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(len)
            .map_err(|_| Error::Limit("source file allocation"))?;
        bytes.resize(len, 0);
        #[cfg(unix)]
        {
            use std::os::unix::fs::FileExt;
            file.read_exact_at(&mut bytes, start as u64)
                .map_err(|_| Error::Io("read source file range"))?;
        }
        #[cfg(not(unix))]
        {
            use std::io::{Read, Seek, SeekFrom};
            let mut file = file;
            file.seek(SeekFrom::Start(start as u64))
                .map_err(|_| Error::Io("seek source file"))?;
            file.read_exact(&mut bytes)
                .map_err(|_| Error::Io("read source file range"))?;
        }
        if FileState::read(&file)? != self.state {
            return Err(Error::Integrity("source file changed"));
        }
        Ok(bytes)
    }
}

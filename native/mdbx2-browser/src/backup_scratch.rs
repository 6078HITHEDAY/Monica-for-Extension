//! Scratch copies never enter persistent browser storage. The enclosing worker
//! owns the browser storage lock for its lifetime; there are no OS file leases.
use std::{io, path::Path};

pub(crate) struct BackupScratch(tempfile::TempDir);

impl BackupScratch {
    pub(crate) fn new(_: &Path) -> io::Result<Self> {
        tempfile::Builder::new().prefix("mdbx-export-").tempdir_in("/tmp").map(Self)
    }
    pub(crate) fn path(&self) -> &Path { self.0.path() }
}

pub(crate) fn scavenge(_: &Path) -> io::Result<()> { Ok(()) }

use std::fs::{File, OpenOptions, TryLockError};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use crate::store::StoreError;
use crate::store::ticket_files::io_error;

const LOCK_FILE: &str = ".git/tikk.lock";
const LOCK_WAIT: Duration = Duration::from_secs(5);
const RETRY_PAUSE: Duration = Duration::from_millis(20);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockAccess {
    Shared,
    Exclusive,
}

/// Holds the store lock until it drops. Closing the file releases the lock, and so does the end of
/// the process.
#[derive(Debug)]
pub struct StoreLock {
    #[expect(dead_code, reason = "the open file holds the lock until it closes")]
    file: File,
}

pub(crate) fn lock_store(root: &Path, access: LockAccess) -> Result<StoreLock, StoreError> {
    lock_store_within(root, access, LOCK_WAIT)
}

pub(crate) fn lock_store_within(
    root: &Path,
    access: LockAccess,
    wait: Duration,
) -> Result<StoreLock, StoreError> {
    let path = root.join(LOCK_FILE);
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|source| io_error("open", &path, source))?;
    let deadline = Instant::now() + wait;

    loop {
        let attempt = match access {
            LockAccess::Shared => file.try_lock_shared(),
            LockAccess::Exclusive => file.try_lock(),
        };

        match attempt {
            Ok(()) => return Ok(StoreLock { file }),
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                thread::sleep(RETRY_PAUSE);
            }
            Err(TryLockError::WouldBlock) => return Err(StoreError::Locked { lock: path }),
            Err(TryLockError::Error(source)) => return Err(io_error("lock", &path, source)),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::thread;
    use std::time::Duration;

    use tempfile::TempDir;

    use super::{LockAccess, lock_store_within};
    use crate::store::StoreError;

    const SHORT_WAIT: Duration = Duration::from_millis(100);

    fn store_folder() -> TempDir {
        let directory = tempfile::tempdir().expect("create a temporary directory");

        fs::create_dir(directory.path().join(".git")).expect("create the Git folder");

        directory
    }

    #[test]
    fn shared_locks_do_not_block_each_other() {
        let store = store_folder();
        let first = lock_store_within(store.path(), LockAccess::Shared, SHORT_WAIT)
            .expect("the first reader locks");

        let second = lock_store_within(store.path(), LockAccess::Shared, SHORT_WAIT);

        assert!(second.is_ok(), "{second:?}");
        drop(first);
    }

    #[test]
    fn a_held_lock_refuses_the_other_access_after_the_wait() {
        let cases = [
            (LockAccess::Exclusive, LockAccess::Shared),
            (LockAccess::Shared, LockAccess::Exclusive),
            (LockAccess::Exclusive, LockAccess::Exclusive),
        ];

        for (held, wanted) in cases {
            let store = store_folder();
            let holder =
                lock_store_within(store.path(), held, SHORT_WAIT).expect("the lock is free");

            let error =
                lock_store_within(store.path(), wanted, SHORT_WAIT).expect_err("the lock is held");

            assert!(
                matches!(&error, StoreError::Locked { lock } if *lock == store.path().join(".git/tikk.lock")),
                "case {held:?} then {wanted:?}: {error:?}"
            );
            drop(holder);
        }
    }

    #[test]
    fn a_waiting_lock_succeeds_when_the_holder_releases_it() {
        let store = store_folder();
        let holder = lock_store_within(store.path(), LockAccess::Exclusive, SHORT_WAIT)
            .expect("the lock is free");
        let releaser = thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            drop(holder);
        });

        let waited = lock_store_within(store.path(), LockAccess::Exclusive, Duration::from_secs(5));

        releaser.join().expect("the releasing thread ends");
        assert!(waited.is_ok(), "{waited:?}");
    }

    #[test]
    fn a_dropped_lock_is_free_again() {
        let store = store_folder();
        let holder = lock_store_within(store.path(), LockAccess::Exclusive, SHORT_WAIT)
            .expect("the lock is free");

        drop(holder);

        let again = lock_store_within(store.path(), LockAccess::Exclusive, Duration::ZERO);
        assert!(again.is_ok(), "{again:?}");
    }

    #[test]
    fn a_store_without_a_git_folder_reports_the_open() {
        let directory = tempfile::tempdir().expect("create a temporary directory");

        let error = lock_store_within(directory.path(), LockAccess::Shared, SHORT_WAIT)
            .expect_err("the lock file has no folder");

        assert!(
            matches!(error, StoreError::Io { action: "open", .. }),
            "{error:?}"
        );
    }
}

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::fact::{Audit, AuditVerdict, FactEvent, FactLine, Repository, ShownAudit, Verdict};
use crate::store::claim_lease::{LeaseEffects, write_for_slice};
use crate::store::fact_files::append_fact;
use crate::store::git;
use crate::store::identity::Identity;
use crate::store::store_lock::{self, LockAccess, StoreLock};
use crate::store::ticket_claim::{check_strictly, refuse_other_kinds};
use crate::store::ticket_files::{io_error, read_tickets};
use crate::store::ticket_index::find_ticket;
use crate::store::{Store, StoreError};
use crate::ticket::{Criterion, TicketId};

#[derive(Clone, Copy)]
pub struct AuditEffects {
    pub lock_store: fn(&Path, LockAccess) -> Result<StoreLock, StoreError>,
    pub read_origin_url: fn(&Path) -> Result<Option<String>, StoreError>,
    pub lease: LeaseEffects,
}

impl AuditEffects {
    pub fn system() -> Self {
        Self {
            lock_store: store_lock::lock_store,
            read_origin_url: git::read_origin_url,
            lease: LeaseEffects::system(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct AuditRequest {
    pub slice: TicketId,
    pub hash: String,
    pub head: String,
    pub file: PathBuf,
    pub repository: Option<Repository>,
    pub working_directory: PathBuf,
}

struct VerdictInput {
    criterion: String,
    verdict: Verdict,
    evidence: String,
}

#[derive(Deserialize)]
struct RawVerdictInput {
    criterion: String,
    verdict: String,
    evidence: String,
}

pub fn audit_slice(
    store: &Store,
    request: &AuditRequest,
    caller: &Identity,
    effects: &AuditEffects,
) -> Result<ShownAudit, StoreError> {
    let inputs = read_verdicts(&request.file)?;
    let repository = match &request.repository {
        Some(repository) => repository.clone(),
        None => origin_repository(&request.working_directory, effects.read_origin_url)?,
    };
    let root = store.root();
    let slice = &request.slice;
    let _lock = (effects.lock_store)(root, LockAccess::Exclusive)?;
    let scan = read_tickets(root)?;
    let ticket = find_ticket(&scan, slice)?;

    if ticket.hash != request.hash {
        return Err(StoreError::ChangedOnDisk {
            path: ticket.path.clone(),
        });
    }

    refuse_other_kinds(ticket)?;
    check_strictly(ticket, &scan, "an audit")?;

    let audit = Audit {
        repository,
        head: request.head.clone(),
        ticket_hash: ticket.hash.clone(),
        verdicts: bind_verdicts(slice, ticket.document.fields.criteria(), inputs)?,
    };

    write_for_slice(root, &scan, Some(slice), caller, &effects.lease, || {
        append_audit(root, slice, audit, &effects.lease)
    })
}

fn read_verdicts(path: &Path) -> Result<Vec<VerdictInput>, StoreError> {
    let text = fs::read_to_string(path).map_err(|source| io_error("read", path, source))?;
    let invalid = |message: String| StoreError::InvalidVerdicts {
        path: path.to_path_buf(),
        message,
    };
    let raw: Vec<RawVerdictInput> = serde_json::from_str(&text).map_err(|error| {
        invalid(format!(
            "{error}; it must be a list of {{\"criterion\", \"verdict\", \"evidence\"}}"
        ))
    })?;
    let mut seen = HashSet::new();
    let mut inputs = Vec::with_capacity(raw.len());

    for entry in raw {
        let verdict = Verdict::parse(&entry.verdict).ok_or_else(|| {
            invalid(format!(
                "`{}` is not a verdict; use met, not-met, not-run, or deferred",
                entry.verdict
            ))
        })?;

        if entry.evidence.trim().is_empty() {
            return Err(invalid(format!(
                "the verdict of `{}` has no evidence",
                entry.criterion
            )));
        }

        if !seen.insert(entry.criterion.clone()) {
            return Err(invalid(format!(
                "the criterion `{}` has two verdicts",
                entry.criterion
            )));
        }

        inputs.push(VerdictInput {
            criterion: entry.criterion,
            verdict,
            evidence: entry.evidence,
        });
    }

    Ok(inputs)
}

fn origin_repository(
    working_directory: &Path,
    read_origin_url: fn(&Path) -> Result<Option<String>, StoreError>,
) -> Result<Repository, StoreError> {
    let origin = read_origin_url(working_directory)?;

    origin
        .as_deref()
        .and_then(Repository::from_origin_url)
        .ok_or(StoreError::NoRepository { origin })
}

fn bind_verdicts(
    slice: &TicketId,
    criteria: &[Criterion],
    inputs: Vec<VerdictInput>,
) -> Result<Vec<AuditVerdict>, StoreError> {
    inputs
        .into_iter()
        .map(|input| {
            let criterion = criteria
                .iter()
                .find(|criterion| criterion.id == input.criterion)
                .ok_or_else(|| StoreError::UnknownCriterion {
                    id: slice.to_string(),
                    criterion: input.criterion.clone(),
                })?;

            Ok(AuditVerdict {
                criterion: input.criterion,
                check: criterion.check.clone(),
                expected: criterion.expected.clone(),
                verdict: input.verdict,
                evidence: input.evidence,
            })
        })
        .collect()
}

// The caller holds the exclusive lock.
fn append_audit(
    root: &Path,
    slice: &TicketId,
    audit: Audit,
    lease: &LeaseEffects,
) -> Result<ShownAudit, StoreError> {
    let shown = ShownAudit {
        audit,
        at: (lease.now)(),
    };
    let fact = FactLine {
        ticket: slice.clone(),
        at: shown.at,
        event: FactEvent::Audit(shown.audit.clone()),
    };

    append_fact(root, &fact, lease.append_line)?;

    Ok(shown)
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, SystemTime};

    use tempfile::TempDir;

    use super::{AuditEffects, AuditRequest, audit_slice};
    use crate::fact::{
        AgentName, AuditVerdict, Claim, FactEvent, FactLine, Repository, Timestamp, Verdict,
        current_claims,
    };
    use crate::store::claim_lease::LeaseEffects;
    use crate::store::fact_files::{append_fact, append_line, read_facts};
    use crate::store::identity::Identity;
    use crate::store::store_lock::{LockAccess, StoreLock};
    use crate::store::ticket_files::sha256_hex;
    use crate::store::{MachineName, Store, StoreEffects, StoreError, init};
    use crate::ticket::TicketId;

    const PLAN: &str = "---\nkind: plan\ntitle: Plan\n---\n";
    const SLICE: &str = "---\nkind: slice\ntitle: Slice\nparent: personal-pppp\ncriteria:\n  - id: s1\n    check: c\n    expected: e\n---\n";

    thread_local! {
        static APPENDS: Cell<usize> = const { Cell::new(0) };
        static LOCKED_WITH: Cell<Option<LockAccess>> = const { Cell::new(None) };
    }

    fn one_hour() -> Timestamp {
        Timestamp::from_system_time(SystemTime::UNIX_EPOCH + Duration::from_secs(3600))
    }

    fn id(text: &str) -> TicketId {
        TicketId::parse(text).expect("a valid ID")
    }

    fn agent(name: &str) -> Identity {
        Identity {
            agent: AgentName::parse(name),
            ..Identity::default()
        }
    }

    fn no_origin(_: &Path) -> Result<Option<String>, StoreError> {
        Ok(None)
    }

    fn busy_lock(_: &Path, access: LockAccess) -> Result<StoreLock, StoreError> {
        LOCKED_WITH.with(|locked| locked.set(Some(access)));

        Err(StoreError::Locked {
            lock: PathBuf::from("tikk.lock"),
        })
    }

    fn second_append_fails(path: &Path, line: &str) -> Result<(), StoreError> {
        let count = APPENDS.with(|appends| appends.replace(appends.get() + 1));

        if count == 0 {
            return append_line(path, line);
        }

        Err(StoreError::Io {
            action: "append to",
            path: path.to_path_buf(),
            source: std::io::Error::other("disk full"),
        })
    }

    fn effects() -> AuditEffects {
        AuditEffects {
            read_origin_url: no_origin,
            lease: LeaseEffects {
                now: one_hour,
                ..LeaseEffects::system()
            },
            ..AuditEffects::system()
        }
    }

    fn store_with_claimed_slice() -> (TempDir, Store, AuditRequest) {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let machine = MachineName::parse("test").expect("a valid machine name");
        init(directory.path(), Some(machine), &StoreEffects::system()).expect("init the store");
        let folder = directory.path().join("tickets/personal");
        fs::create_dir_all(&folder).expect("create the project folder");
        fs::write(folder.join("personal-pppp-plan.md"), PLAN).expect("write the plan");
        fs::write(folder.join("personal-kkkk-slice.md"), SLICE).expect("write the slice");
        let start = Timestamp::from_system_time(SystemTime::UNIX_EPOCH);
        let claim = Claim::starting(
            AgentName::parse("manager").expect("a valid name"),
            None,
            None,
            start,
        );
        let fact = FactLine {
            ticket: id("personal-kkkk"),
            at: start,
            event: FactEvent::Claim(claim),
        };
        append_fact(directory.path(), &fact, append_line).expect("append the claim");
        let file = directory.path().join("verdicts.json");
        fs::write(
            &file,
            "[{\"criterion\":\"s1\",\"verdict\":\"met\",\"evidence\":\"seen\"}]",
        )
        .expect("write the verdicts");
        let request = AuditRequest {
            slice: id("personal-kkkk"),
            hash: sha256_hex(SLICE.as_bytes()),
            head: "head".to_owned(),
            file,
            repository: Repository::parse("owner/app"),
            working_directory: directory.path().to_path_buf(),
        };
        let store = Store {
            root: directory.path().to_path_buf(),
        };

        (directory, store, request)
    }

    fn audit_count(store: &Store) -> usize {
        read_facts(store.root())
            .expect("read the facts")
            .facts
            .iter()
            .filter(|fact| matches!(fact.event, FactEvent::Audit(_)))
            .count()
    }

    #[test]
    fn audit_waits_for_the_exclusive_lock_and_writes_nothing_without_it() {
        let (_directory, store, request) = store_with_claimed_slice();
        let effects = AuditEffects {
            lock_store: busy_lock,
            ..effects()
        };

        let error = audit_slice(&store, &request, &agent("manager"), &effects)
            .expect_err("the lock is held");

        assert!(matches!(error, StoreError::Locked { .. }), "{error:?}");
        assert_eq!(LOCKED_WITH.with(Cell::get), Some(LockAccess::Exclusive));
        assert_eq!(audit_count(&store), 0);
    }

    #[test]
    fn audit_by_the_holder_appends_the_audit_and_renews_the_lease() {
        let (_directory, store, request) = store_with_claimed_slice();

        let shown = audit_slice(&store, &request, &agent("manager"), &effects())
            .expect("the holder audits");

        let facts = read_facts(store.root()).expect("read the facts").facts;
        let claim = current_claims(&facts)
            .remove(&id("personal-kkkk"))
            .expect("a claim");
        assert_eq!(shown.at, one_hour());
        assert_eq!(shown.audit.head, "head");
        assert_eq!(audit_count(&store), 1);
        assert_eq!(
            claim.lease_end,
            one_hour().after(Duration::from_secs(4 * 3600))
        );
    }

    #[test]
    fn audit_whose_renewal_fails_returns_the_error_and_keeps_the_audit() {
        let (_directory, store, request) = store_with_claimed_slice();
        APPENDS.with(|appends| appends.set(0));
        let effects = AuditEffects {
            lease: LeaseEffects {
                now: one_hour,
                append_line: second_append_fails,
            },
            ..effects()
        };

        let error = audit_slice(&store, &request, &agent("manager"), &effects)
            .expect_err("the renewal fails");

        let facts = read_facts(store.root()).expect("read the facts").facts;
        let claim = current_claims(&facts)
            .remove(&id("personal-kkkk"))
            .expect("a claim");
        assert!(matches!(error, StoreError::Io { .. }), "{error:?}");
        assert_eq!(audit_count(&store), 1);
        assert_eq!(
            claim.lease_end,
            Timestamp::from_system_time(SystemTime::UNIX_EPOCH)
                .after(Duration::from_secs(4 * 3600))
        );
    }

    #[test]
    fn audit_by_a_person_is_never_refused_for_a_claim() {
        let (_directory, store, request) = store_with_claimed_slice();

        audit_slice(&store, &request, &Identity::default(), &effects())
            .expect("a person audits a claimed slice");

        assert_eq!(audit_count(&store), 1);
    }

    #[test]
    fn audit_records_each_verdict_of_the_file_with_the_criterion_text_of_the_slice() {
        let (_directory, store, request) = store_with_claimed_slice();

        let shown = audit_slice(&store, &request, &Identity::default(), &effects())
            .expect("the audit runs");

        let expected = vec![AuditVerdict {
            criterion: "s1".to_owned(),
            check: "c".to_owned(),
            expected: "e".to_owned(),
            verdict: Verdict::Met,
            evidence: "seen".to_owned(),
        }];
        let facts = read_facts(store.root()).expect("read the facts").facts;
        let recorded = facts.iter().find_map(|fact| match &fact.event {
            FactEvent::Audit(audit) => Some(audit.verdicts.clone()),
            _ => None,
        });
        assert_eq!(shown.audit.verdicts, expected);
        assert_eq!(recorded, Some(expected));
    }

    #[test]
    fn audit_refuses_a_criterion_the_slice_does_not_have_and_a_wrong_file() {
        let cases = [
            (
                "[{\"criterion\":\"s9\",\"verdict\":\"met\",\"evidence\":\"seen\"}]",
                "unknown",
            ),
            (
                "[{\"criterion\":\"s1\",\"verdict\":\"passed\",\"evidence\":\"seen\"}]",
                "invalid",
            ),
        ];

        for (text, case) in cases {
            let (_directory, store, request) = store_with_claimed_slice();
            fs::write(&request.file, text).expect("write the verdicts");

            let error = audit_slice(&store, &request, &Identity::default(), &effects())
                .expect_err("the audit is refused");

            let matched = match case {
                "unknown" => matches!(
                    &error,
                    StoreError::UnknownCriterion { id, criterion }
                        if id == "personal-kkkk" && criterion == "s9"
                ),
                _ => matches!(&error, StoreError::InvalidVerdicts { .. }),
            };
            assert!(matched, "case {case}: {error:?}");
            assert_eq!(audit_count(&store), 0, "case {case}");
        }
    }
}

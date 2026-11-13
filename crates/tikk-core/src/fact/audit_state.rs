use std::collections::HashMap;

use crate::fact::{FactEvent, FactLine, Repository, Timestamp};
use crate::ticket::TicketId;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Met,
    NotMet,
    NotRun,
    Deferred,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditVerdict {
    pub criterion: String,
    pub check: String,
    pub expected: String,
    pub verdict: Verdict,
    pub evidence: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Audit {
    pub repository: Repository,
    pub head: String,
    pub ticket_hash: String,
    pub verdicts: Vec<AuditVerdict>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShownAudit {
    pub audit: Audit,
    pub at: Timestamp,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Met => "met",
            Self::NotMet => "not-met",
            Self::NotRun => "not-run",
            Self::Deferred => "deferred",
        }
    }

    pub(crate) fn parse(text: &str) -> Option<Self> {
        match text {
            "met" => Some(Self::Met),
            "not-met" => Some(Self::NotMet),
            "not-run" => Some(Self::NotRun),
            "deferred" => Some(Self::Deferred),
            _ => None,
        }
    }
}

// The newest audit fact of each ticket wins; the facts come in the store's fact order.
pub(crate) fn last_audits<'a>(
    facts: impl IntoIterator<Item = &'a FactLine>,
) -> HashMap<TicketId, ShownAudit> {
    let mut audits = HashMap::new();

    for fact in facts {
        if let FactEvent::Audit(audit) = &fact.event {
            audits.insert(
                fact.ticket.clone(),
                ShownAudit {
                    audit: audit.clone(),
                    at: fact.at,
                },
            );
        }
    }

    audits
}

#[cfg(test)]
mod tests {
    use super::{Audit, Verdict, last_audits};
    use crate::fact::{FactEvent, FactLine, Repository, Timestamp};
    use crate::ticket::TicketId;

    fn audit_fact(ticket: &str, time: &str, head: &str) -> FactLine {
        FactLine {
            ticket: TicketId::parse(ticket).expect("a valid ID"),
            at: Timestamp::parse(time).expect("a valid time"),
            event: FactEvent::Audit(Audit {
                repository: Repository::parse("owner/app").expect("a valid repository"),
                head: head.to_owned(),
                ticket_hash: "hash".to_owned(),
                verdicts: Vec::new(),
            }),
        }
    }

    #[test]
    fn the_last_audit_of_each_ticket_is_its_newest_fact() {
        let facts = [
            audit_fact("tikk-abcd", "2026-11-13T01:00:00Z", "first"),
            audit_fact("tikk-efgh", "2026-11-13T02:00:00Z", "other"),
            audit_fact("tikk-abcd", "2026-11-13T03:00:00Z", "second"),
        ];

        let audits = last_audits(&facts);

        let head = |ticket: &str| {
            audits[&TicketId::parse(ticket).expect("a valid ID")]
                .audit
                .head
                .clone()
        };
        assert_eq!(head("tikk-abcd"), "second");
        assert_eq!(head("tikk-efgh"), "other");
    }

    #[test]
    fn a_verdict_reads_back_from_its_text() {
        for verdict in [
            Verdict::Met,
            Verdict::NotMet,
            Verdict::NotRun,
            Verdict::Deferred,
        ] {
            assert_eq!(
                Verdict::parse(verdict.as_str()),
                Some(verdict),
                "{verdict:?}"
            );
        }

        assert_eq!(Verdict::parse("passed"), None);
    }
}

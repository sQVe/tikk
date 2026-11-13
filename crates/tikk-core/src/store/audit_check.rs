use crate::fact::{ShownAudit, ShownPr, Verdict};
use crate::ticket::Criterion;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuditReason {
    NotLinked,
    RepositoryDiffers,
    HeadDiffers,
    CriterionMissing(String),
    CriterionChanged(String),
    NotMet(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditCheck {
    pub audit: ShownAudit,
    pub reasons: Vec<AuditReason>,
}

impl AuditReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::NotLinked => "notLinked",
            Self::RepositoryDiffers => "repositoryDiffers",
            Self::HeadDiffers => "headDiffers",
            Self::CriterionMissing(_) => "criterionMissing",
            Self::CriterionChanged(_) => "criterionChanged",
            Self::NotMet(_) => "notMet",
        }
    }

    pub fn criterion(&self) -> Option<&str> {
        match self {
            Self::NotLinked | Self::RepositoryDiffers | Self::HeadDiffers => None,
            Self::CriterionMissing(criterion)
            | Self::CriterionChanged(criterion)
            | Self::NotMet(criterion) => Some(criterion),
        }
    }
}

impl AuditCheck {
    pub fn counts(&self) -> bool {
        self.reasons.is_empty()
    }
}

pub(crate) fn check_audit(
    audit: ShownAudit,
    criteria: &[Criterion],
    pr: Option<&ShownPr>,
) -> AuditCheck {
    let mut reasons = Vec::new();

    match pr.map(|pr| &pr.observation) {
        None => reasons.push(AuditReason::NotLinked),
        Some(observation) => {
            if observation.pull_request.repository() != audit.audit.repository.as_str() {
                reasons.push(AuditReason::RepositoryDiffers);
            }

            if observation.head != audit.audit.head {
                reasons.push(AuditReason::HeadDiffers);
            }
        }
    }

    for criterion in criteria {
        let verdict = audit
            .audit
            .verdicts
            .iter()
            .find(|verdict| verdict.criterion == criterion.id);
        let Some(verdict) = verdict else {
            reasons.push(AuditReason::CriterionMissing(criterion.id.clone()));
            continue;
        };
        let same_text = verdict.check == criterion.check && verdict.expected == criterion.expected;

        if !same_text {
            reasons.push(AuditReason::CriterionChanged(criterion.id.clone()));
        }

        if verdict.verdict != Verdict::Met {
            reasons.push(AuditReason::NotMet(criterion.id.clone()));
        }
    }

    AuditCheck { audit, reasons }
}

#[cfg(test)]
mod tests {
    use super::{AuditReason, check_audit};
    use crate::fact::{
        Audit, AuditVerdict, PrObservation, PrState, PullRequest, Repository, ShownAudit, ShownPr,
        Timestamp, Verdict,
    };
    use crate::ticket::Criterion;

    fn time() -> Timestamp {
        Timestamp::parse("2026-11-13T01:00:00Z").expect("a valid time")
    }

    fn criterion(id: &str) -> Criterion {
        Criterion {
            id: id.to_owned(),
            check: "c".to_owned(),
            expected: "e".to_owned(),
        }
    }

    fn pr() -> ShownPr {
        ShownPr {
            observation: PrObservation {
                pull_request: PullRequest::new("owner/app", 7).expect("a valid PR"),
                state: PrState::Merged,
                base: "main".to_owned(),
                head: "head".to_owned(),
                merge_commit: Some("merge".to_owned()),
                in_trunk: true,
            },
            checked_at: time(),
        }
    }

    fn audit(repository: &str, head: &str, verdicts: &[(&str, &str, Verdict)]) -> ShownAudit {
        ShownAudit {
            audit: Audit {
                repository: Repository::parse(repository).expect("a valid repository"),
                head: head.to_owned(),
                ticket_hash: "hash".to_owned(),
                verdicts: verdicts
                    .iter()
                    .map(|(criterion, expected, verdict)| AuditVerdict {
                        criterion: (*criterion).to_owned(),
                        check: "c".to_owned(),
                        expected: (*expected).to_owned(),
                        verdict: *verdict,
                        evidence: "seen".to_owned(),
                    })
                    .collect(),
            },
            at: time(),
        }
    }

    #[test]
    fn an_audit_of_the_pr_head_with_every_criterion_met_counts() {
        let met = audit("owner/app", "head", &[("s1", "e", Verdict::Met)]);

        let check = check_audit(met, &[criterion("s1")], Some(&pr()));

        assert_eq!(check.reasons, Vec::new());
        assert!(check.counts());
    }

    #[test]
    fn an_audit_lists_each_reason_it_does_not_count() {
        let criteria = [criterion("s1"), criterion("s2")];
        let cases = [
            (
                "another repository and head",
                audit(
                    "owner/other",
                    "old",
                    &[("s1", "e", Verdict::Met), ("s2", "e", Verdict::Met)],
                ),
                vec![AuditReason::RepositoryDiffers, AuditReason::HeadDiffers],
            ),
            (
                "a changed, a missing, and a not-run criterion",
                audit(
                    "owner/app",
                    "head",
                    &[("s1", "old", Verdict::NotRun), ("gone", "e", Verdict::Met)],
                ),
                vec![
                    AuditReason::CriterionChanged("s1".to_owned()),
                    AuditReason::NotMet("s1".to_owned()),
                    AuditReason::CriterionMissing("s2".to_owned()),
                ],
            ),
        ];

        for (name, audit, expected) in cases {
            let check = check_audit(audit, &criteria, Some(&pr()));

            assert_eq!(check.reasons, expected, "case {name}");
            assert!(!check.counts(), "case {name}");
        }
    }

    #[test]
    fn an_audit_of_a_slice_without_a_pr_does_not_count() {
        let met = audit("owner/app", "head", &[("s1", "e", Verdict::Met)]);

        let check = check_audit(met, &[criterion("s1")], None);

        assert_eq!(check.reasons, vec![AuditReason::NotLinked]);
    }

    #[test]
    fn each_audit_reason_has_its_json_name_and_criterion() {
        let criterion = || "s1".to_owned();
        let reasons = [
            (AuditReason::NotLinked, "notLinked", None),
            (AuditReason::RepositoryDiffers, "repositoryDiffers", None),
            (AuditReason::HeadDiffers, "headDiffers", None),
            (
                AuditReason::CriterionMissing(criterion()),
                "criterionMissing",
                Some("s1"),
            ),
            (
                AuditReason::CriterionChanged(criterion()),
                "criterionChanged",
                Some("s1"),
            ),
            (AuditReason::NotMet(criterion()), "notMet", Some("s1")),
        ];

        for (reason, name, expected) in reasons {
            assert_eq!(reason.as_str(), name, "case {reason:?}");
            assert_eq!(reason.criterion(), expected, "case {reason:?}");
        }
    }
}

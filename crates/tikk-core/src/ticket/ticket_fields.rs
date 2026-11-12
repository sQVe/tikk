use std::collections::BTreeSet;

use crate::ticket::ticket_document::{RawCriterion, RawFrontMatter};
use crate::ticket::{Kind, Status, TicketError, TicketId};

/// The front matter of a ticket that passed the rules one file can show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TicketFields {
    kind: Kind,
    title: String,
    status: Status,
    reason: Option<String>,
    parent: Option<TicketId>,
    rank: Option<i64>,
    blocked_by: Vec<TicketId>,
    discovered_from: Option<TicketId>,
    related: Vec<TicketId>,
    criteria: Vec<Criterion>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Criterion {
    pub id: String,
    pub check: String,
    pub expected: String,
}

impl TicketFields {
    /// An open ticket with no criteria and no edges.
    pub fn new(kind: Kind, title: &str, parent: Option<TicketId>) -> Result<Self, TicketError> {
        let fields = Self {
            kind,
            title: required(Some(title.to_owned()), "title")?,
            status: Status::Open,
            reason: None,
            parent,
            rank: None,
            blocked_by: Vec::new(),
            discovered_from: None,
            related: Vec::new(),
            criteria: Vec::new(),
        };

        fields.check_rules()?;

        Ok(fields)
    }

    pub(crate) fn from_raw(raw: RawFrontMatter) -> Result<Self, TicketError> {
        let kind = required(raw.kind, "kind")?;
        let kind = Kind::parse(&kind).map_err(|_| {
            TicketError::invalid("kind", "must be plan, slice, instruction, or task")
        })?;
        let status = match raw.status {
            None => Status::Open,
            Some(text) => Status::parse(&text).map_err(|_| {
                TicketError::invalid("status", "must be draft, open, done, or canceled")
            })?,
        };
        let fields = Self {
            kind,
            title: required(raw.title, "title")?,
            status,
            reason: raw.reason.filter(|reason| !reason.trim().is_empty()),
            parent: raw
                .parent
                .map(|text| parse_edge(&text, "parent"))
                .transpose()?,
            rank: raw.rank,
            blocked_by: parse_edges(&raw.blocked_by, "blockedBy")?,
            discovered_from: raw
                .discovered_from
                .map(|text| parse_edge(&text, "discoveredFrom"))
                .transpose()?,
            related: parse_edges(&raw.related, "related")?,
            criteria: parse_criteria(raw.criteria)?,
        };

        fields.check_rules()?;

        Ok(fields)
    }

    pub fn kind(&self) -> Kind {
        self.kind
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn status(&self) -> Status {
        self.status
    }

    pub fn reason(&self) -> Option<&str> {
        self.reason.as_deref()
    }

    pub fn parent(&self) -> Option<&TicketId> {
        self.parent.as_ref()
    }

    pub fn rank(&self) -> Option<i64> {
        self.rank
    }

    pub fn blocked_by(&self) -> &[TicketId] {
        &self.blocked_by
    }

    pub fn discovered_from(&self) -> Option<&TicketId> {
        self.discovered_from.as_ref()
    }

    pub fn related(&self) -> &[TicketId] {
        &self.related
    }

    pub fn criteria(&self) -> &[Criterion] {
        &self.criteria
    }

    fn check_rules(&self) -> Result<(), TicketError> {
        if !self.kind.allows(self.status) {
            return Err(TicketError::invalid(
                "status",
                format!("cannot be {} for a {}", self.status, self.kind),
            ));
        }

        if self.status == Status::Canceled && self.reason.is_none() {
            return Err(TicketError::invalid(
                "reason",
                "is required when the status is canceled",
            ));
        }

        if let Some(problem) = parent_presence_problem(self.kind, self.parent.is_some()) {
            return Err(TicketError::invalid("parent", problem));
        }

        if !self.criteria.is_empty() && !self.kind.has_criteria() {
            return Err(TicketError::invalid(
                "criteria",
                format!("belong only to plans and slices, not to a {}", self.kind),
            ));
        }

        Ok(())
    }
}

fn parent_presence_problem(kind: Kind, has_parent: bool) -> Option<&'static str> {
    match (kind, has_parent) {
        (Kind::Plan, true) => Some("must be empty, because a plan has no parent"),
        (Kind::Slice, false) => Some("is required, because a slice sits under a plan"),
        (Kind::Instruction, false) => {
            Some("is required, because an instruction sits under a slice")
        }
        _ => None,
    }
}

fn required(value: Option<String>, field: &str) -> Result<String, TicketError> {
    value
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| TicketError::invalid(field, "is required"))
}

fn parse_edge(text: &str, field: &str) -> Result<TicketId, TicketError> {
    TicketId::parse(text).map_err(|_| {
        TicketError::invalid(field, format!("names `{text}`, which is not a ticket ID"))
    })
}

fn parse_edges(texts: &[String], field: &str) -> Result<Vec<TicketId>, TicketError> {
    texts.iter().map(|text| parse_edge(text, field)).collect()
}

fn parse_criteria(raw: Vec<RawCriterion>) -> Result<Vec<Criterion>, TicketError> {
    let mut seen = BTreeSet::new();
    let mut criteria = Vec::with_capacity(raw.len());

    for (index, criterion) in raw.into_iter().enumerate() {
        let field = |name: &str| format!("criteria[{index}].{name}");
        let id = required(criterion.id, &field("id"))?;

        if !seen.insert(id.clone()) {
            return Err(TicketError::invalid(
                field("id"),
                format!("repeats the criterion ID `{id}`"),
            ));
        }

        criteria.push(Criterion {
            id,
            check: required(criterion.check, &field("check"))?,
            expected: required(criterion.expected, &field("expected"))?,
        });
    }

    Ok(criteria)
}

#[cfg(test)]
mod tests {
    use super::TicketFields;
    use crate::ticket::ticket_document::{RawCriterion, RawFrontMatter};
    use crate::ticket::{Kind, Status, TicketError, TicketId};

    fn raw(kind: &str) -> RawFrontMatter {
        RawFrontMatter {
            kind: Some(kind.to_owned()),
            title: Some("A title".to_owned()),
            ..RawFrontMatter::default()
        }
    }

    fn criterion(id: Option<&str>) -> RawCriterion {
        RawCriterion {
            id: id.map(str::to_owned),
            check: Some("cargo nextest run".to_owned()),
            expected: Some("passes".to_owned()),
        }
    }

    fn field_of(error: &TicketError) -> &str {
        match error {
            TicketError::Invalid { field, .. } => field,
            other => panic!("not a validation error: {other:?}"),
        }
    }

    #[test]
    fn a_missing_status_is_open() {
        let fields = TicketFields::from_raw(raw("task")).expect("a task without status is valid");

        assert_eq!(fields.status(), Status::Open);
    }

    #[test]
    fn an_unknown_kind_names_the_kind_field() {
        let error = TicketFields::from_raw(raw("epic")).expect_err("epic is not a kind");

        assert_eq!(field_of(&error), "kind");
    }

    #[test]
    fn a_criterion_without_id_names_its_id_field() {
        let front = RawFrontMatter {
            parent: Some("personal-abcd".to_owned()),
            criteria: vec![criterion(Some("c1")), criterion(None)],
            ..raw("slice")
        };

        let error = TicketFields::from_raw(front).expect_err("the second criterion has no id");

        assert_eq!(field_of(&error), "criteria[1].id");
    }

    #[test]
    fn a_canceled_ticket_without_reason_names_the_reason_field() {
        let front = RawFrontMatter {
            status: Some("canceled".to_owned()),
            ..raw("task")
        };

        let error = TicketFields::from_raw(front).expect_err("a reason is required");

        assert_eq!(field_of(&error), "reason");
    }

    #[test]
    fn each_broken_rule_names_its_field() {
        let cases = [
            (
                "missing title",
                RawFrontMatter {
                    title: None,
                    ..raw("task")
                },
                "title",
            ),
            (
                "missing kind",
                RawFrontMatter {
                    kind: None,
                    ..raw("task")
                },
                "kind",
            ),
            (
                "unknown status",
                RawFrontMatter {
                    status: Some("closed".to_owned()),
                    ..raw("task")
                },
                "status",
            ),
            (
                "done plan",
                RawFrontMatter {
                    status: Some("done".to_owned()),
                    ..raw("plan")
                },
                "status",
            ),
            (
                "draft task",
                RawFrontMatter {
                    status: Some("draft".to_owned()),
                    ..raw("task")
                },
                "status",
            ),
            (
                "plan with a parent",
                RawFrontMatter {
                    parent: Some("personal-abcd".to_owned()),
                    ..raw("plan")
                },
                "parent",
            ),
            ("slice without parent", raw("slice"), "parent"),
            ("instruction without parent", raw("instruction"), "parent"),
            (
                "malformed parent",
                RawFrontMatter {
                    parent: Some("nope".to_owned()),
                    ..raw("task")
                },
                "parent",
            ),
            (
                "malformed blocker",
                RawFrontMatter {
                    blocked_by: vec!["nope".to_owned()],
                    ..raw("task")
                },
                "blockedBy",
            ),
            (
                "malformed discovery",
                RawFrontMatter {
                    discovered_from: Some("nope".to_owned()),
                    ..raw("task")
                },
                "discoveredFrom",
            ),
            (
                "malformed related",
                RawFrontMatter {
                    related: vec!["nope".to_owned()],
                    ..raw("task")
                },
                "related",
            ),
            (
                "criteria on a task",
                RawFrontMatter {
                    criteria: vec![criterion(Some("c1"))],
                    ..raw("task")
                },
                "criteria",
            ),
            (
                "repeated criterion",
                RawFrontMatter {
                    criteria: vec![criterion(Some("c1")), criterion(Some("c1"))],
                    ..raw("plan")
                },
                "criteria[1].id",
            ),
            (
                "criterion without check",
                RawFrontMatter {
                    criteria: vec![RawCriterion {
                        check: None,
                        ..criterion(Some("c1"))
                    }],
                    ..raw("plan")
                },
                "criteria[0].check",
            ),
            (
                "criterion without expected",
                RawFrontMatter {
                    criteria: vec![RawCriterion {
                        expected: None,
                        ..criterion(Some("c1"))
                    }],
                    ..raw("plan")
                },
                "criteria[0].expected",
            ),
        ];

        for (name, front, field) in cases {
            let error = TicketFields::from_raw(front).expect_err("the rule is broken");

            assert_eq!(field_of(&error), field, "case {name}");
        }
    }

    #[test]
    fn new_checks_the_parent_rule_of_its_kind() {
        let error =
            TicketFields::new(Kind::Instruction, "Write it", None).expect_err("no parent given");

        assert_eq!(field_of(&error), "parent");
    }

    #[test]
    fn new_refuses_a_blank_title() {
        let error = TicketFields::new(Kind::Task, "  ", None).expect_err("the title is blank");

        assert_eq!(field_of(&error), "title");
    }

    #[test]
    fn new_makes_an_open_ticket_under_its_parent() {
        let parent = TicketId::parse("personal-abcd").expect("a valid ID");

        let fields = TicketFields::new(Kind::Slice, "Add files", Some(parent.clone()))
            .expect("a slice under a parent is valid");

        assert_eq!(fields.status(), Status::Open);
        assert_eq!(fields.parent(), Some(&parent));
        assert_eq!(fields.title(), "Add files");
    }
}

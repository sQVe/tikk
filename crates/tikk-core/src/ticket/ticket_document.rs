use serde::Deserialize;

use crate::ticket::{TicketError, TicketFields};

const FENCE: &str = "---";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TicketDocument {
    pub fields: TicketFields,
    pub body: String,
}

impl TicketDocument {
    pub fn parse(text: &str) -> Result<Self, TicketError> {
        let (front_matter, body) = split_front_matter(text)?;
        let raw = if front_matter.trim().is_empty() {
            RawFrontMatter::default()
        } else {
            serde_saphyr::from_str(front_matter).map_err(|error| TicketError::Parse {
                message: first_line(&error.to_string()),
            })?
        };

        Ok(Self {
            fields: TicketFields::from_raw(raw)?,
            body: body.to_owned(),
        })
    }
}

pub(crate) fn write_document(fields: &TicketFields, body: &str) -> String {
    let yaml = serde_saphyr::to_string(fields)
        .expect("front matter of strings, numbers, and lists always serializes");

    format!("{FENCE}\n{yaml}{FENCE}\n{body}")
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RawFrontMatter {
    pub(crate) kind: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) status: Option<String>,
    pub(crate) reason: Option<String>,
    pub(crate) parent: Option<String>,
    pub(crate) rank: Option<i64>,
    #[serde(default)]
    pub(crate) blocked_by: Vec<String>,
    pub(crate) discovered_from: Option<String>,
    #[serde(default)]
    pub(crate) related: Vec<String>,
    #[serde(default)]
    pub(crate) criteria: Vec<RawCriterion>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawCriterion {
    pub(crate) id: Option<String>,
    pub(crate) check: Option<String>,
    pub(crate) expected: Option<String>,
}

fn split_front_matter(text: &str) -> Result<(&str, &str), TicketError> {
    let mut lines = text.split_inclusive('\n');
    let opening = lines.next().unwrap_or_default();

    if opening.trim_end() != FENCE {
        return Err(TicketError::Parse {
            message: "the file must start with a line of three hyphens, ---".to_owned(),
        });
    }

    let start = opening.len();
    let mut offset = start;

    for line in lines {
        if line.trim_end() == FENCE {
            return Ok((&text[start..offset], &text[offset + line.len()..]));
        }

        offset += line.len();
    }

    Err(TicketError::Parse {
        message: "the front matter has no closing line of three hyphens, ---".to_owned(),
    })
}

fn first_line(message: &str) -> String {
    message.lines().next().unwrap_or_default().to_owned()
}

#[cfg(test)]
mod tests {
    use super::{TicketDocument, write_document};
    use crate::ticket::{Kind, Status, TicketError, TicketId};

    #[test]
    fn parse_reads_the_front_matter_and_keeps_the_body() {
        let text = "---\nkind: slice\ntitle: \"Lock: the store\"\nstatus: draft\nparent: personal-abcd\nrank: 2\nblockedBy:\n  - personal-wxyz\ncriteria:\n  - id: c1\n    check: cargo nextest run\n    expected: passes\n---\n# Design\n\nText.\n";

        let document = TicketDocument::parse(text).expect("the document parses");

        let fields = &document.fields;
        assert_eq!(fields.kind(), Kind::Slice);
        assert_eq!(fields.title(), "Lock: the store");
        assert_eq!(fields.status(), Status::Draft);
        assert_eq!(fields.rank(), Some(2));
        assert_eq!(
            fields.blocked_by(),
            &[TicketId::parse("personal-wxyz").expect("a valid ID")]
        );
        assert_eq!(fields.criteria()[0].id, "c1");
        assert_eq!(document.body, "# Design\n\nText.\n");
    }

    #[test]
    fn write_then_parse_gives_the_same_document() {
        let text = "---\nkind: slice\ntitle: \"Lock: the store\"\nstatus: canceled\nreason: 'Out of scope: #1'\nparent: personal-abcd\nrank: -1\nblockedBy: [personal-wxyz]\ndiscoveredFrom: personal-wxyz\nrelated: [personal-3333]\ncriteria:\n  - id: c1\n    check: 'yes: no'\n    expected: \"- a list?\"\n---\nBody\n";
        let document = TicketDocument::parse(text).expect("the document parses");

        let written = write_document(&document.fields, &document.body);

        assert_eq!(TicketDocument::parse(&written), Ok(document));
    }

    #[test]
    fn write_puts_every_field_in_its_fixed_order() {
        let text = "---\ncriteria:\n  - expected: passes\n    check: cargo nextest run\n    id: c1\nrelated: [personal-3333]\ndiscoveredFrom: personal-4444\nblockedBy: [personal-6666, personal-7777]\nrank: 2\nparent: personal-abcd\nreason: Out of scope\nstatus: canceled\ntitle: Lock the store\nkind: slice\n---\nBody\n";
        let document = TicketDocument::parse(text).expect("the document parses");

        let written = write_document(&document.fields, &document.body);

        assert_eq!(
            written,
            "---\nkind: slice\ntitle: Lock the store\nstatus: canceled\nreason: Out of scope\nparent: personal-abcd\nrank: 2\nblockedBy:\n- personal-6666\n- personal-7777\ndiscoveredFrom: personal-4444\nrelated:\n- personal-3333\ncriteria:\n- id: c1\n  check: cargo nextest run\n  expected: passes\n---\nBody\n"
        );
    }

    #[test]
    fn write_puts_fields_in_order_and_leaves_out_empty_ones() {
        let document =
            TicketDocument::parse("---\ntitle: T\nkind: task\n---\n").expect("the document parses");

        let written = write_document(&document.fields, "");

        assert_eq!(written, "---\nkind: task\ntitle: T\nstatus: open\n---\n");
    }

    #[test]
    fn parse_refuses_broken_documents() {
        let cases = [
            ("no front matter", "kind: task\n"),
            ("no closing line", "---\nkind: task\ntitle: T\n"),
            ("broken YAML", "---\nkind: [task\n---\n"),
            (
                "unknown field",
                "---\nkind: task\ntitle: T\nproject: tikk\n---\n",
            ),
        ];

        for (name, text) in cases {
            let error = TicketDocument::parse(text).expect_err("the document is broken");

            assert!(
                matches!(&error, TicketError::Parse { message } if !message.contains('\n')),
                "case {name}: {error:?}"
            );
        }
    }

    #[test]
    fn an_empty_front_matter_names_the_kind_field() {
        let error = TicketDocument::parse("---\n---\n").expect_err("kind is required");

        assert!(
            matches!(&error, TicketError::Invalid { field, .. } if field == "kind"),
            "{error:?}"
        );
    }
}

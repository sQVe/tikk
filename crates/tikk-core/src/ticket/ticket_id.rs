use std::fmt;

use serde::{Serialize, Serializer};

use crate::ticket::{ProjectName, TicketError};

/// The ID alphabet leaves out the look-alike characters 0, 1, 2, 5, l, o, s, u, and v.
pub const ID_ALPHABET: &str = "346789abcdefghijkmnpqrtwxyz";

const CODE_LENGTH: usize = 4;

const UNBIASED_LIMIT: u8 = (256 / ID_ALPHABET.len() * ID_ALPHABET.len()) as u8;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TicketId {
    project: ProjectName,
    code: String,
}

impl TicketId {
    pub fn parse(text: &str) -> Result<Self, TicketError> {
        let invalid = |reason| TicketError::InvalidId {
            value: text.to_owned(),
            reason,
        };
        let Some((project, code)) = text.rsplit_once('-') else {
            return Err(invalid("use the form <project>-<4 characters>"));
        };
        let project = ProjectName::parse(project)
            .map_err(|_| invalid("the part before the last hyphen is not a project name"))?;

        if !is_code(code) {
            return Err(invalid(
                "the last part must be 4 characters of 346789abcdefghijkmnpqrtwxyz",
            ));
        }

        Ok(Self {
            project,
            code: code.to_owned(),
        })
    }

    pub fn draw(project: &ProjectName, random: &[u8]) -> Option<Self> {
        let alphabet = ID_ALPHABET.as_bytes();
        let code: String = random
            .iter()
            .filter(|byte| **byte < UNBIASED_LIMIT)
            .take(CODE_LENGTH)
            .map(|byte| char::from(alphabet[usize::from(*byte) % alphabet.len()]))
            .collect();

        (code.len() == CODE_LENGTH).then(|| Self {
            project: project.clone(),
            code,
        })
    }

    pub fn from_file_name(project: &ProjectName, file_name: &str) -> Option<Self> {
        let stem = file_name.strip_suffix(".md")?;
        let rest = stem.strip_prefix(project.as_str())?.strip_prefix('-')?;
        let code = rest.get(..CODE_LENGTH)?;
        let after = &rest[CODE_LENGTH..];
        let ends_the_id = after.is_empty() || after.starts_with('-');

        (is_code(code) && ends_the_id).then(|| Self {
            project: project.clone(),
            code: code.to_owned(),
        })
    }

    pub fn project(&self) -> &ProjectName {
        &self.project
    }
}

impl Serialize for TicketId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl fmt::Display for TicketId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}-{}", self.project, self.code)
    }
}

fn is_code(code: &str) -> bool {
    code.len() == CODE_LENGTH
        && code
            .chars()
            .all(|character| ID_ALPHABET.contains(character))
}

#[cfg(test)]
mod tests {
    use super::{TicketId, UNBIASED_LIMIT};
    use crate::ticket::{ProjectName, TicketError};

    fn project() -> ProjectName {
        ProjectName::parse("my-app").expect("a valid project name")
    }

    #[test]
    fn parse_splits_the_project_at_the_last_hyphen() {
        let id = TicketId::parse("my-app-3x9k").expect("a valid ID parses");

        assert_eq!(id.project(), &project());
        assert_eq!(id.to_string(), "my-app-3x9k");
    }

    #[test]
    fn parse_refuses_each_invalid_form() {
        let cases = [
            ("tikk", "use the form <project>-<4 characters>"),
            (
                "-3x9k",
                "the part before the last hyphen is not a project name",
            ),
            (
                "tikk-3x9",
                "the last part must be 4 characters of 346789abcdefghijkmnpqrtwxyz",
            ),
            (
                "tikk-3x9l",
                "the last part must be 4 characters of 346789abcdefghijkmnpqrtwxyz",
            ),
        ];

        for (text, reason) in cases {
            let error = TicketId::parse(text).expect_err("the ID is invalid");

            assert_eq!(
                error,
                TicketError::InvalidId {
                    value: text.to_owned(),
                    reason,
                },
                "case {text:?}"
            );
        }
    }

    #[test]
    fn draw_maps_bytes_to_the_alphabet_and_skips_biased_bytes() {
        let id = TicketId::draw(
            &project(),
            &[0, 255, UNBIASED_LIMIT, 26, 27, UNBIASED_LIMIT - 1, 9],
        )
        .expect("four bytes are usable");

        assert_eq!(id.to_string(), "my-app-3z3z");
    }

    #[test]
    fn draw_needs_four_usable_bytes() {
        let id = TicketId::draw(&project(), &[1, 2, 255, 3]);

        assert_eq!(id, None);
    }

    #[test]
    fn from_file_name_reads_the_id_before_the_slug() {
        let cases = [
            ("my-app-3x9k-write-the-parser.md", Some("my-app-3x9k")),
            ("my-app-3x9k.md", Some("my-app-3x9k")),
            ("my-app-3x9kz.md", None),
            ("my-app-3x9k-write.txt", None),
            ("other-3x9k.md", None),
            ("my-app-3x.md", None),
        ];

        for (file_name, expected) in cases {
            let id = TicketId::from_file_name(&project(), file_name);

            assert_eq!(
                id.map(|id| id.to_string()).as_deref(),
                expected,
                "case {file_name}"
            );
        }
    }
}

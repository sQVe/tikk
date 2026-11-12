use std::fmt;

use crate::ticket::TicketError;

const PERSONAL: &str = "personal";

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProjectName(String);

impl ProjectName {
    pub fn parse(name: &str) -> Result<Self, TicketError> {
        let invalid = |reason| TicketError::InvalidProject {
            value: name.to_owned(),
            reason,
        };

        if name.is_empty() {
            return Err(invalid("it is empty"));
        }

        if name.starts_with('-') {
            return Err(invalid("it starts with a hyphen"));
        }

        if !name.chars().all(is_name_character) {
            return Err(invalid("use only lowercase letters, digits, and hyphens"));
        }

        Ok(Self(name.to_owned()))
    }

    pub fn personal() -> Self {
        Self(PERSONAL.to_owned())
    }

    pub fn from_origin_url(url: &str) -> Result<Self, TicketError> {
        let trimmed = url.trim().trim_end_matches('/');
        let last = trimmed.rsplit(['/', ':']).next().unwrap_or_default();
        let name = last.strip_suffix(".git").unwrap_or(last);

        Self::parse(&name.to_lowercase())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ProjectName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

fn is_name_character(character: char) -> bool {
    character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
}

#[cfg(test)]
mod tests {
    use super::ProjectName;
    use crate::ticket::TicketError;

    #[test]
    fn parse_accepts_lowercase_letters_digits_and_hyphens() {
        for name in ["tikk", "my-app", "a2", "9lives"] {
            let parsed = ProjectName::parse(name).expect("a valid project name parses");

            assert_eq!(parsed.as_str(), name, "case {name}");
        }
    }

    #[test]
    fn parse_refuses_each_invalid_form() {
        let cases = [
            ("", "it is empty"),
            ("-app", "it starts with a hyphen"),
            ("My_App", "use only lowercase letters, digits, and hyphens"),
        ];

        for (name, expected) in cases {
            let error = ProjectName::parse(name).expect_err("the name is invalid");

            assert_eq!(
                error,
                TicketError::InvalidProject {
                    value: name.to_owned(),
                    reason: expected,
                },
                "case {name:?}"
            );
        }
    }

    #[test]
    fn from_origin_url_takes_the_lowercase_repository_name() {
        let cases = [
            ("git@github.com:owner/Tikk.git", "tikk"),
            ("https://github.com/owner/tikk", "tikk"),
            ("https://github.com/owner/tikk.git/", "tikk"),
            ("/srv/git/my-app.git\n", "my-app"),
            ("server:app", "app"),
        ];

        for (url, expected) in cases {
            let project = ProjectName::from_origin_url(url).expect("the URL names a project");

            assert_eq!(project.as_str(), expected, "case {url:?}");
        }
    }

    #[test]
    fn from_origin_url_refuses_a_name_that_is_not_a_project() {
        let error =
            ProjectName::from_origin_url("git@github.com:owner/my_app.git").expect_err("invalid");

        assert!(
            matches!(&error, TicketError::InvalidProject { value, .. } if value == "my_app"),
            "{error:?}"
        );
    }
}

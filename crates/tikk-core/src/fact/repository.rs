use std::fmt;

const ORIGIN_STARTS: [&str; 3] = [
    "https://github.com/",
    "git@github.com:",
    "ssh://git@github.com/",
];

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Repository(String);

impl Repository {
    pub fn parse(text: &str) -> Option<Self> {
        let (owner, name) = text.split_once('/')?;

        (is_name(owner) && is_name(name)).then(|| Self(text.to_owned()))
    }

    pub fn from_origin_url(url: &str) -> Option<Self> {
        let trimmed = url.trim().trim_end_matches('/');
        let path = ORIGIN_STARTS
            .iter()
            .find_map(|start| trimmed.strip_prefix(start))?;

        Self::parse(path.strip_suffix(".git").unwrap_or(path))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Repository {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

fn is_name(text: &str) -> bool {
    let allowed = |character: char| character.is_ascii_alphanumeric() || "-_.".contains(character);

    !text.is_empty() && text.chars().all(allowed)
}

#[cfg(test)]
mod tests {
    use super::Repository;

    #[test]
    fn parse_takes_an_owner_and_a_name() {
        let cases = [
            ("owner/app", true),
            ("my-org/app.rs", true),
            ("owner", false),
            ("owner/", false),
            ("/app", false),
            ("owner/app/extra", false),
            ("owner/a b", false),
        ];

        for (text, valid) in cases {
            assert_eq!(Repository::parse(text).is_some(), valid, "case {text}");
        }
    }

    #[test]
    fn from_origin_url_reads_the_github_https_and_ssh_forms() {
        let cases = [
            ("https://github.com/owner/app.git", Some("owner/app")),
            ("https://github.com/owner/app", Some("owner/app")),
            ("https://github.com/owner/app/", Some("owner/app")),
            ("git@github.com:owner/app.git", Some("owner/app")),
            ("ssh://git@github.com/owner/app.git\n", Some("owner/app")),
            ("https://gitlab.com/owner/app.git", None),
            ("git@example.com:owner/app.git", None),
            ("/srv/git/app.git", None),
            ("https://github.com/owner", None),
        ];

        for (url, expected) in cases {
            assert_eq!(
                Repository::from_origin_url(url)
                    .as_ref()
                    .map(Repository::as_str),
                expected,
                "case {url}"
            );
        }
    }
}

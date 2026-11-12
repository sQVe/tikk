use std::fmt;

use crate::store::StoreError;

/// A machine name: lowercase ASCII letters, digits, and hyphens, not starting with a hyphen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachineName(String);

impl MachineName {
    pub fn parse(name: &str) -> Result<Self, StoreError> {
        let invalid = |reason| StoreError::InvalidMachineName {
            name: name.to_owned(),
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

    /// Takes the first dot-separated label of the host name, lowercased.
    pub(crate) fn from_host_name(host_name: &str) -> Result<Self, StoreError> {
        let host_name = host_name.trim();
        let label = host_name.split('.').next().unwrap_or_default();

        Self::parse(&label.to_lowercase()).map_err(|_| StoreError::InvalidHostName {
            host_name: host_name.to_owned(),
        })
    }
}

impl fmt::Display for MachineName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

fn is_name_character(character: char) -> bool {
    character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
}

#[cfg(test)]
mod tests {
    use super::MachineName;
    use crate::store::StoreError;

    #[test]
    fn parse_accepts_lowercase_letters_digits_and_hyphens() {
        for name in ["laptop", "desk-2", "a"] {
            let parsed = MachineName::parse(name).expect("a valid machine name parses");

            assert_eq!(parsed.to_string(), name, "case {name}");
        }
    }

    #[test]
    fn parse_names_the_reason_for_each_invalid_name() {
        let cases = [
            ("", "it is empty"),
            ("-laptop", "it starts with a hyphen"),
            ("Laptop", "use only lowercase letters, digits, and hyphens"),
            (
                "my laptop",
                "use only lowercase letters, digits, and hyphens",
            ),
            ("a/b", "use only lowercase letters, digits, and hyphens"),
        ];

        for (name, expected_reason) in cases {
            let error = MachineName::parse(name).expect_err("an invalid name is refused");

            assert!(
                matches!(
                    &error,
                    StoreError::InvalidMachineName { name: found, reason }
                        if found == name && *reason == expected_reason
                ),
                "case {name:?}: {error:?}"
            );
        }
    }

    #[test]
    fn from_host_name_takes_the_first_label_lowercased() {
        let cases = [
            ("Laptop.example.com\n", "laptop"),
            ("desk\n", "desk"),
            ("  Build-01.local  ", "build-01"),
        ];

        for (host_name, expected) in cases {
            let machine =
                MachineName::from_host_name(host_name).expect("a valid host name gives a name");

            assert_eq!(machine.to_string(), expected, "case {host_name:?}");
        }
    }

    #[test]
    fn from_host_name_refuses_a_label_that_is_not_a_machine_name() {
        let error = MachineName::from_host_name("my_host.local\n")
            .expect_err("an underscore is not allowed");

        assert!(
            matches!(&error, StoreError::InvalidHostName { host_name } if host_name == "my_host.local"),
            "{error:?}"
        );
    }
}

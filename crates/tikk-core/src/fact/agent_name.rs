use std::fmt;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AgentName(String);

impl AgentName {
    pub fn parse(name: &str) -> Option<Self> {
        if name.is_empty() {
            return None;
        }

        Some(Self(name.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Serialize for AgentName {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl fmt::Display for AgentName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::AgentName;

    #[test]
    fn parse_keeps_a_name_and_refuses_an_empty_one() {
        let name = AgentName::parse("manager-1").expect("a name parses");

        assert_eq!(name.as_str(), "manager-1");
        assert_eq!(AgentName::parse(""), None);
    }
}

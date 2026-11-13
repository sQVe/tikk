use std::ffi::OsString;

use crate::fact::AgentName;
use crate::store::StoreError;

/// Who runs a command. With no agent, the caller is a person.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Identity {
    pub agent: Option<AgentName>,
    pub session: Option<String>,
    pub session_log: Option<String>,
}

impl Identity {
    /// Parses the values of `TIKK_AGENT`, `TIKK_SESSION`, and `TIKK_SESSION_LOG`. An empty
    /// value counts as unset.
    pub fn from_environment(
        agent: Option<OsString>,
        session: Option<OsString>,
        session_log: Option<OsString>,
    ) -> Result<Self, StoreError> {
        let agent = text("TIKK_AGENT", agent)?;

        Ok(Self {
            agent: agent.as_deref().and_then(AgentName::parse),
            session: text("TIKK_SESSION", session)?,
            session_log: text("TIKK_SESSION_LOG", session_log)?,
        })
    }
}

fn text(variable: &'static str, value: Option<OsString>) -> Result<Option<String>, StoreError> {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    value
        .into_string()
        .map(Some)
        .map_err(|_| StoreError::NotUnicode { variable })
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt as _;

    use super::Identity;
    use crate::store::StoreError;

    #[test]
    fn from_environment_reads_the_agent_and_its_session() {
        let identity = Identity::from_environment(
            Some(OsString::from("manager")),
            Some(OsString::from("session-1")),
            Some(OsString::from("/logs/session-1.jsonl")),
        )
        .expect("the values are text");

        assert_eq!(
            identity.agent.as_ref().map(|agent| agent.as_str()),
            Some("manager")
        );
        assert_eq!(identity.session.as_deref(), Some("session-1"));
        assert_eq!(
            identity.session_log.as_deref(),
            Some("/logs/session-1.jsonl")
        );
    }

    #[test]
    fn an_empty_value_counts_as_unset() {
        let empty = Some(OsString::new());

        let identity = Identity::from_environment(empty.clone(), empty.clone(), empty)
            .expect("empty values are unset");

        assert_eq!(identity, Identity::default());
    }

    #[test]
    fn a_value_that_is_not_unicode_names_its_variable() {
        let bytes = Some(OsString::from_vec(vec![0xff]));

        let error =
            Identity::from_environment(None, bytes, None).expect_err("the session is not Unicode");

        assert!(
            matches!(
                error,
                StoreError::NotUnicode {
                    variable: "TIKK_SESSION"
                }
            ),
            "{error:?}"
        );
    }
}

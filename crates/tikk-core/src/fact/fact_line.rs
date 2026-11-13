use serde::{Deserialize, Serialize};

use crate::fact::{AgentName, Claim, FactError, Timestamp};
use crate::ticket::TicketId;

const VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FactLine {
    pub(crate) ticket: TicketId,
    pub(crate) at: Timestamp,
    pub(crate) event: FactEvent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FactEvent {
    Claim(Claim),
    Release { agent: Option<AgentName> },
}

// Fields beyond these are ignored, so a later version may add some.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawFact {
    v: u32,
    kind: String,
    ticket: String,
    at: String,
    agent: Option<String>,
    session: Option<String>,
    session_log: Option<String>,
    lease_end: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaimText<'a> {
    v: u32,
    kind: &'static str,
    ticket: String,
    at: String,
    agent: &'a str,
    session: Option<&'a str>,
    session_log: Option<&'a str>,
    lease_end: String,
}

#[derive(Serialize)]
struct ReleaseText<'a> {
    v: u32,
    kind: &'static str,
    ticket: String,
    at: String,
    agent: Option<&'a str>,
}

pub(crate) fn parse_fact_line(text: &str) -> Result<FactLine, FactError> {
    let raw: RawFact = serde_json::from_str(text)
        .map_err(|error| FactError::new(format!("the line is not a fact: {error}")))?;

    if raw.v != VERSION {
        return Err(FactError::new(format!(
            "the line has the version {}, and tikk reads version {VERSION}",
            raw.v
        )));
    }

    let ticket = TicketId::parse(&raw.ticket).map_err(|error| FactError::new(error.to_string()))?;
    let at = Timestamp::parse(&raw.at)?;
    let event = match raw.kind.as_str() {
        "claim" => FactEvent::Claim(parse_claim(raw)?),
        "release" => FactEvent::Release {
            agent: raw.agent.as_deref().and_then(AgentName::parse),
        },
        other => {
            return Err(FactError::new(format!(
                "`{other}` is not a fact kind; use claim or release"
            )));
        }
    };

    Ok(FactLine { ticket, at, event })
}

pub(crate) fn write_fact_line(fact: &FactLine) -> String {
    let ticket = fact.ticket.to_string();
    let at = fact.at.to_string();
    let text = match &fact.event {
        FactEvent::Claim(claim) => serde_json::to_string(&ClaimText {
            v: VERSION,
            kind: "claim",
            ticket,
            at,
            agent: claim.agent.as_str(),
            session: claim.session.as_deref(),
            session_log: claim.session_log.as_deref(),
            lease_end: claim.lease_end.to_string(),
        }),
        FactEvent::Release { agent } => serde_json::to_string(&ReleaseText {
            v: VERSION,
            kind: "release",
            ticket,
            at,
            agent: agent.as_ref().map(AgentName::as_str),
        }),
    };

    format!("{}\n", text.expect("a fact serializes to JSON"))
}

fn parse_claim(raw: RawFact) -> Result<Claim, FactError> {
    let agent = raw
        .agent
        .as_deref()
        .and_then(AgentName::parse)
        .ok_or_else(|| FactError::new("a claim needs a non-empty `agent`".to_owned()))?;
    let lease_end = raw
        .lease_end
        .as_deref()
        .ok_or_else(|| FactError::new("a claim needs `leaseEnd`".to_owned()))?;

    Ok(Claim {
        agent,
        session: raw.session,
        session_log: raw.session_log,
        lease_end: Timestamp::parse(lease_end)?,
    })
}

#[cfg(test)]
mod tests {
    use super::{FactEvent, FactLine, parse_fact_line, write_fact_line};
    use crate::fact::{AgentName, Claim, Timestamp};
    use crate::ticket::TicketId;

    fn at(text: &str) -> Timestamp {
        Timestamp::parse(text).expect("a valid time")
    }

    fn slice() -> TicketId {
        TicketId::parse("tikk-abcd").expect("a valid ID")
    }

    #[test]
    fn a_claim_line_has_its_fields_in_order_and_parses_back() {
        let fact = FactLine {
            ticket: slice(),
            at: at("2026-11-13T01:00:00Z"),
            event: FactEvent::Claim(Claim {
                agent: AgentName::parse("manager").expect("a valid name"),
                session: Some("session-1".to_owned()),
                session_log: None,
                lease_end: at("2026-11-13T05:00:00Z"),
            }),
        };

        let text = write_fact_line(&fact);

        assert_eq!(
            text,
            "{\"v\":1,\"kind\":\"claim\",\"ticket\":\"tikk-abcd\",\"at\":\"2026-11-13T01:00:00.000Z\",\"agent\":\"manager\",\"session\":\"session-1\",\"sessionLog\":null,\"leaseEnd\":\"2026-11-13T05:00:00.000Z\"}\n"
        );
        assert_eq!(parse_fact_line(text.trim_end()), Ok(fact));
    }

    #[test]
    fn a_release_by_a_person_has_a_null_agent() {
        let fact = FactLine {
            ticket: slice(),
            at: at("2026-11-13T01:00:00Z"),
            event: FactEvent::Release { agent: None },
        };

        let text = write_fact_line(&fact);

        assert_eq!(
            text,
            "{\"v\":1,\"kind\":\"release\",\"ticket\":\"tikk-abcd\",\"at\":\"2026-11-13T01:00:00.000Z\",\"agent\":null}\n"
        );
        assert_eq!(parse_fact_line(text.trim_end()), Ok(fact));
    }

    #[test]
    fn parse_names_what_is_wrong_with_a_line() {
        let claim = "\"ticket\":\"tikk-abcd\",\"at\":\"2026-11-13T01:00:00Z\"";
        let cases = [
            ("{\"v\":1,", "not a fact"),
            (
                "{\"v\":2,\"kind\":\"claim\",\"ticket\":\"tikk-abcd\",\"at\":\"2026-11-13T01:00:00Z\"}",
                "version 2",
            ),
            (
                "{\"v\":1,\"kind\":\"claim\",\"ticket\":\"Bad\",\"at\":\"2026-11-13T01:00:00Z\"}",
                "not a ticket ID",
            ),
            (
                "{\"v\":1,\"kind\":\"claim\",\"ticket\":\"tikk-abcd\",\"at\":\"soon\"}",
                "RFC 3339",
            ),
            (
                "{\"v\":1,\"kind\":\"log\",\"ticket\":\"tikk-abcd\",\"at\":\"2026-11-13T01:00:00Z\"}",
                "not a fact kind",
            ),
        ];
        let missing = [
            (
                format!(
                    "{{\"v\":1,\"kind\":\"claim\",{claim},\"agent\":\"\",\"leaseEnd\":\"2026-11-13T05:00:00Z\"}}"
                ),
                "`agent`",
            ),
            (
                format!("{{\"v\":1,\"kind\":\"claim\",{claim},\"agent\":\"manager\"}}"),
                "`leaseEnd`",
            ),
        ];
        let all = cases
            .iter()
            .map(|(text, expected)| ((*text).to_owned(), *expected))
            .chain(missing);

        for (text, expected) in all {
            let error = parse_fact_line(&text).expect_err("the line is refused");

            assert!(error.to_string().contains(expected), "case {text}: {error}");
        }
    }
}

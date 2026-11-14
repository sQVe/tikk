use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::fact::{
    AgentName, Audit, AuditVerdict, Claim, FactError, PrObservation, PrState, PullRequest,
    QuestionItem, Repository, Timestamp, Verdict,
};
use crate::ticket::TicketId;

const VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FactLine {
    pub(crate) ticket: TicketId,
    pub(crate) at: Timestamp,
    pub(crate) event: FactEvent,
}

// Untagged, because the line writes `kind` before `ticket` and `at`, ahead of the event's fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub(crate) enum FactEvent {
    Claim(Claim),
    Release { agent: Option<AgentName> },
    Pr(PrObservation),
    Audit(Audit),
    Question { item: QuestionItem, text: String },
    Answer { item: QuestionItem, text: String },
}

impl FactEvent {
    fn kind(&self) -> &'static str {
        match self {
            Self::Claim(_) => "claim",
            Self::Release { .. } => "release",
            Self::Pr(_) => "pr",
            Self::Audit(_) => "audit",
            Self::Question { .. } => "question",
            Self::Answer { .. } => "answer",
        }
    }
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
    repository: Option<String>,
    number: Option<u64>,
    state: Option<String>,
    base: Option<String>,
    head: Option<String>,
    merge_commit: Option<String>,
    in_trunk: Option<bool>,
    ticket_hash: Option<String>,
    verdicts: Option<Vec<RawVerdict>>,
    item: Option<String>,
    text: Option<String>,
}

#[derive(Deserialize)]
struct RawVerdict {
    criterion: String,
    check: String,
    expected: String,
    verdict: String,
    evidence: String,
}

#[derive(Serialize)]
struct FactText<'a> {
    v: u32,
    kind: &'static str,
    ticket: &'a TicketId,
    at: Timestamp,
    #[serde(flatten)]
    event: &'a FactEvent,
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
        "pr" => FactEvent::Pr(parse_pr(raw)?),
        "audit" => FactEvent::Audit(parse_audit(raw)?),
        "question" => {
            let (item, text) = parse_item_text("a question", raw)?;

            FactEvent::Question { item, text }
        }
        "answer" => {
            let (item, text) = parse_item_text("an answer", raw)?;

            FactEvent::Answer { item, text }
        }
        other => {
            return Err(FactError::new(format!(
                "`{other}` is not a fact kind; use claim, release, pr, audit, question, or answer"
            )));
        }
    };

    Ok(FactLine { ticket, at, event })
}

pub(crate) fn write_fact_line(fact: &FactLine) -> String {
    let text = serde_json::to_string(&FactText {
        v: VERSION,
        kind: fact.event.kind(),
        ticket: &fact.ticket,
        at: fact.at,
        event: &fact.event,
    })
    .expect("a fact serializes to JSON");

    format!("{text}\n")
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

fn parse_item_text(fact: &str, raw: RawFact) -> Result<(QuestionItem, String), FactError> {
    let missing = |field: &str| FactError::new(format!("{fact} fact needs `{field}`"));
    let item = raw.item.ok_or_else(|| missing("item"))?;
    let item = QuestionItem::parse(&item).ok_or_else(|| {
        FactError::new(format!(
            "`{item}` is not an item ID; use 4 characters of 346789abcdefghijkmnpqrtwxyz"
        ))
    })?;

    Ok((item, raw.text.ok_or_else(|| missing("text"))?))
}

fn parse_pr(raw: RawFact) -> Result<PrObservation, FactError> {
    let missing = |field: &str| FactError::new(format!("a pr fact needs `{field}`"));
    let repository = raw.repository.ok_or_else(|| missing("repository"))?;
    let number = raw.number.ok_or_else(|| missing("number"))?;
    let pull_request = PullRequest::new(&repository, number).ok_or_else(|| {
        FactError::new(format!(
            "`{repository}` and {number} name no PR; use an `owner/name` and a number above 0"
        ))
    })?;
    let state = raw.state.ok_or_else(|| missing("state"))?;
    let state = PrState::parse(&state).ok_or_else(|| {
        FactError::new(format!(
            "`{state}` is not a PR state; use open, closed, or merged"
        ))
    })?;

    Ok(PrObservation {
        pull_request,
        state,
        base: raw.base.ok_or_else(|| missing("base"))?,
        head: raw.head.ok_or_else(|| missing("head"))?,
        merge_commit: raw.merge_commit,
        in_trunk: raw.in_trunk.ok_or_else(|| missing("inTrunk"))?,
    })
}

fn parse_audit(raw: RawFact) -> Result<Audit, FactError> {
    let missing = |field: &str| FactError::new(format!("an audit fact needs `{field}`"));
    let repository = raw.repository.ok_or_else(|| missing("repository"))?;
    let repository = Repository::parse(&repository).ok_or_else(|| {
        FactError::new(format!(
            "`{repository}` is not a repository; use `owner/name`"
        ))
    })?;
    let verdicts: Vec<AuditVerdict> = raw
        .verdicts
        .ok_or_else(|| missing("verdicts"))?
        .into_iter()
        .map(parse_verdict)
        .collect::<Result<_, _>>()?;
    let mut seen = HashSet::new();

    for verdict in &verdicts {
        if !seen.insert(verdict.criterion.as_str()) {
            return Err(FactError::new(format!(
                "the criterion `{}` has two verdicts",
                verdict.criterion
            )));
        }
    }

    Ok(Audit {
        repository,
        head: raw.head.ok_or_else(|| missing("head"))?,
        ticket_hash: raw.ticket_hash.ok_or_else(|| missing("ticketHash"))?,
        verdicts,
    })
}

fn parse_verdict(raw: RawVerdict) -> Result<AuditVerdict, FactError> {
    let verdict = Verdict::parse(&raw.verdict).ok_or_else(|| {
        FactError::new(format!(
            "`{}` is not a verdict; use met, not-met, not-run, or deferred",
            raw.verdict
        ))
    })?;

    if raw.evidence.trim().is_empty() {
        return Err(FactError::new(format!(
            "the verdict of `{}` has no evidence",
            raw.criterion
        )));
    }

    Ok(AuditVerdict {
        criterion: raw.criterion,
        check: raw.check,
        expected: raw.expected,
        verdict,
        evidence: raw.evidence,
    })
}

#[cfg(test)]
mod tests {
    use super::{FactEvent, FactLine, parse_fact_line, write_fact_line};
    use crate::fact::{
        AgentName, Audit, AuditVerdict, Claim, PrObservation, PrState, PullRequest, QuestionItem,
        Repository, Timestamp, Verdict,
    };
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
    fn a_pr_line_has_its_fields_in_order_and_parses_back() {
        let fact = FactLine {
            ticket: slice(),
            at: at("2026-11-13T01:00:00Z"),
            event: FactEvent::Pr(PrObservation {
                pull_request: PullRequest::new("owner/app", 7).expect("a valid PR"),
                state: PrState::Merged,
                base: "main".to_owned(),
                head: "abc".to_owned(),
                merge_commit: Some("def".to_owned()),
                in_trunk: true,
            }),
        };

        let text = write_fact_line(&fact);

        assert_eq!(
            text,
            "{\"v\":1,\"kind\":\"pr\",\"ticket\":\"tikk-abcd\",\"at\":\"2026-11-13T01:00:00.000Z\",\"repository\":\"owner/app\",\"number\":7,\"state\":\"merged\",\"base\":\"main\",\"head\":\"abc\",\"mergeCommit\":\"def\",\"inTrunk\":true}\n"
        );
        assert_eq!(parse_fact_line(text.trim_end()), Ok(fact));
    }

    #[test]
    fn an_audit_line_has_its_fields_in_order_and_parses_back() {
        let fact = FactLine {
            ticket: slice(),
            at: at("2026-11-13T01:00:00Z"),
            event: FactEvent::Audit(Audit {
                repository: Repository::parse("owner/app").expect("a valid repository"),
                head: "abc".to_owned(),
                ticket_hash: "hash".to_owned(),
                verdicts: vec![AuditVerdict {
                    criterion: "s1".to_owned(),
                    check: "c".to_owned(),
                    expected: "e".to_owned(),
                    verdict: Verdict::NotMet,
                    evidence: "It failed.".to_owned(),
                }],
            }),
        };

        let text = write_fact_line(&fact);

        assert_eq!(
            text,
            "{\"v\":1,\"kind\":\"audit\",\"ticket\":\"tikk-abcd\",\"at\":\"2026-11-13T01:00:00.000Z\",\"repository\":\"owner/app\",\"head\":\"abc\",\"ticketHash\":\"hash\",\"verdicts\":[{\"criterion\":\"s1\",\"check\":\"c\",\"expected\":\"e\",\"verdict\":\"not-met\",\"evidence\":\"It failed.\"}]}\n"
        );
        assert_eq!(parse_fact_line(text.trim_end()), Ok(fact));
    }

    #[test]
    fn parse_names_what_is_wrong_with_an_audit_line() {
        let start =
            "{\"v\":1,\"kind\":\"audit\",\"ticket\":\"tikk-abcd\",\"at\":\"2026-11-13T01:00:00Z\"";
        let verdict = "{\"criterion\":\"s1\",\"check\":\"c\",\"expected\":\"e\",\"verdict\":\"met\",\"evidence\":\"x\"}";
        let whole = format!(
            "\"repository\":\"owner/app\",\"head\":\"abc\",\"ticketHash\":\"hash\",\"verdicts\":[{verdict}]"
        );
        let cases = [
            (
                whole.replace("\"repository\":\"owner/app\",", ""),
                "`repository`",
            ),
            (whole.replace("\"head\":\"abc\",", ""), "`head`"),
            (
                whole.replace("\"ticketHash\":\"hash\",", ""),
                "`ticketHash`",
            ),
            (
                whole.replace(&format!(",\"verdicts\":[{verdict}]"), ""),
                "`verdicts`",
            ),
            (whole.replace("owner/app", "owner"), "not a repository"),
            (whole.replace("\"met\"", "\"passed\""), "not a verdict"),
            (
                whole.replace("\"evidence\":\"x\"", "\"evidence\":\" \""),
                "`s1` has no evidence",
            ),
            (
                whole.replace(&format!("[{verdict}]"), &format!("[{verdict},{verdict}]")),
                "`s1` has two verdicts",
            ),
        ];

        assert!(parse_fact_line(&format!("{start},{whole}}}")).is_ok());
        for (fields, expected) in cases {
            let error =
                parse_fact_line(&format!("{start},{fields}}}")).expect_err("the line is refused");

            assert!(
                error.to_string().contains(expected),
                "case {fields}: {error}"
            );
        }
    }

    #[test]
    fn question_and_answer_lines_have_their_fields_in_order_and_parse_back() {
        let item = QuestionItem::parse("ab3x").expect("a valid item");
        let cases = [
            (
                FactEvent::Question {
                    item: item.clone(),
                    text: "Which crate?".to_owned(),
                },
                "question",
                "Which crate?",
            ),
            (
                FactEvent::Answer {
                    item,
                    text: "serde-saphyr".to_owned(),
                },
                "answer",
                "serde-saphyr",
            ),
        ];

        for (event, kind, text) in cases {
            let fact = FactLine {
                ticket: slice(),
                at: at("2026-11-13T01:00:00Z"),
                event,
            };

            let line = write_fact_line(&fact);

            assert_eq!(
                line,
                format!(
                    "{{\"v\":1,\"kind\":\"{kind}\",\"ticket\":\"tikk-abcd\",\"at\":\"2026-11-13T01:00:00.000Z\",\"item\":\"ab3x\",\"text\":\"{text}\"}}\n"
                ),
                "case {kind}"
            );
            assert_eq!(parse_fact_line(line.trim_end()), Ok(fact), "case {kind}");
        }
    }

    #[test]
    fn parse_names_what_is_wrong_with_a_question_or_answer_line() {
        let start = "\"ticket\":\"tikk-abcd\",\"at\":\"2026-11-13T01:00:00Z\"";
        let cases = [
            (
                "question",
                "\"text\":\"Which crate?\"",
                "a question fact needs `item`",
            ),
            ("answer", "\"item\":\"ab3x\"", "an answer fact needs `text`"),
            (
                "question",
                "\"item\":\"AB3X\",\"text\":\"x\"",
                "`AB3X` is not an item ID",
            ),
        ];

        for (kind, fields, expected) in cases {
            let text = format!("{{\"v\":1,\"kind\":\"{kind}\",{start},{fields}}}");

            let error = parse_fact_line(&text).expect_err("the line is refused");

            assert!(error.to_string().contains(expected), "case {text}: {error}");
        }
    }

    #[test]
    fn parse_names_what_is_wrong_with_a_pr_line() {
        let start =
            "{\"v\":1,\"kind\":\"pr\",\"ticket\":\"tikk-abcd\",\"at\":\"2026-11-13T01:00:00Z\"";
        let whole = "\"repository\":\"owner/app\",\"number\":7,\"state\":\"open\",\"base\":\"main\",\"head\":\"abc\",\"mergeCommit\":null,\"inTrunk\":false";
        let cases = [
            ("\"repository\":\"owner/app\",", "`repository`"),
            ("\"number\":7,", "`number`"),
            ("\"state\":\"open\",", "`state`"),
            ("\"base\":\"main\",", "`base`"),
            ("\"head\":\"abc\",", "`head`"),
            (",\"inTrunk\":false", "`inTrunk`"),
        ];

        assert!(parse_fact_line(&format!("{start},{whole}}}")).is_ok());
        for (field, expected) in cases {
            let text = format!("{start},{}}}", whole.replace(field, ""));

            let error = parse_fact_line(&text).expect_err("the line is refused");

            assert!(
                error.to_string().contains(expected),
                "case {field}: {error}"
            );
        }

        let wrong = [
            (whole.replace("owner/app", "owner"), "name no PR"),
            (whole.replace("\"number\":7", "\"number\":0"), "name no PR"),
            (whole.replace("\"open\"", "\"OPEN\""), "not a PR state"),
        ];

        for (fields, expected) in wrong {
            let error =
                parse_fact_line(&format!("{start},{fields}}}")).expect_err("the line is refused");

            assert!(
                error.to_string().contains(expected),
                "case {fields}: {error}"
            );
        }
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

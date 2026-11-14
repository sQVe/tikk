use std::collections::HashMap;
use std::time::Duration;

use crate::fact::{AgentName, FactEvent, FactLine, Timestamp};
use crate::ticket::TicketId;

const LEASE: Duration = Duration::from_secs(4 * 60 * 60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claim {
    pub agent: AgentName,
    pub session: Option<String>,
    pub session_log: Option<String>,
    pub lease_end: Timestamp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimState {
    Claimed,
    StaleClaim,
}

impl Claim {
    pub(crate) fn starting(
        agent: AgentName,
        session: Option<String>,
        session_log: Option<String>,
        now: Timestamp,
    ) -> Self {
        Self {
            agent,
            session,
            session_log,
            lease_end: now.after(LEASE),
        }
    }

    pub(crate) fn renewed(&self, now: Timestamp) -> Self {
        Self {
            lease_end: now.after(LEASE),
            ..self.clone()
        }
    }

    pub fn state(&self, now: Timestamp) -> ClaimState {
        if now < self.lease_end {
            ClaimState::Claimed
        } else {
            ClaimState::StaleClaim
        }
    }

    pub(crate) fn is_live(&self, now: Timestamp) -> bool {
        self.state(now) == ClaimState::Claimed
    }
}

impl ClaimState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claimed => "claimed",
            Self::StaleClaim => "staleClaim",
        }
    }
}

// A claim replaces the ticket's claim, and a release ends it, whoever wrote either.
pub(crate) fn current_claims<'a>(
    facts: impl IntoIterator<Item = &'a FactLine>,
) -> HashMap<TicketId, Claim> {
    let mut claims = HashMap::new();

    for fact in facts {
        match &fact.event {
            FactEvent::Claim(claim) => {
                claims.insert(fact.ticket.clone(), claim.clone());
            }
            FactEvent::Release { .. } => {
                claims.remove(&fact.ticket);
            }
            FactEvent::Pr(_) | FactEvent::Audit(_) => {}
        }
    }

    claims
}

#[cfg(test)]
mod tests {
    use super::{Claim, ClaimState, current_claims};
    use crate::fact::{AgentName, FactEvent, FactLine, Timestamp};
    use crate::ticket::TicketId;

    fn at(text: &str) -> Timestamp {
        Timestamp::parse(text).expect("a valid time")
    }

    fn agent(name: &str) -> AgentName {
        AgentName::parse(name).expect("a valid agent name")
    }

    fn slice() -> TicketId {
        TicketId::parse("tikk-abcd").expect("a valid ID")
    }

    fn claim_by(name: &str, now: &str) -> FactLine {
        FactLine {
            ticket: slice(),
            at: at(now),
            event: FactEvent::Claim(Claim::starting(agent(name), None, None, at(now))),
        }
    }

    #[test]
    fn a_claim_is_live_before_its_lease_ends_and_stale_after() {
        let claim = Claim::starting(agent("manager"), None, None, at("2026-11-13T00:00:00Z"));

        let cases = [
            ("2026-11-13T03:59:59.999Z", ClaimState::Claimed),
            ("2026-11-13T04:00:00Z", ClaimState::StaleClaim),
            ("2026-11-13T09:00:00Z", ClaimState::StaleClaim),
        ];

        assert_eq!(claim.lease_end, at("2026-11-13T04:00:00Z"));
        for (now, expected) in cases {
            assert_eq!(claim.state(at(now)), expected, "case {now}");
        }
    }

    #[test]
    fn each_claim_state_has_its_contract_name() {
        assert_eq!(ClaimState::Claimed.as_str(), "claimed");
        assert_eq!(ClaimState::StaleClaim.as_str(), "staleClaim");
    }

    #[test]
    fn the_last_claim_wins_and_a_release_ends_it() {
        let first = claim_by("manager-1", "2026-11-13T00:00:00Z");
        let second = claim_by("manager-2", "2026-11-13T05:00:00Z");
        let release = FactLine {
            ticket: slice(),
            at: at("2026-11-13T06:00:00Z"),
            event: FactEvent::Release { agent: None },
        };

        let held = current_claims([&first, &second]);
        let released = current_claims([&first, &second, &release]);

        assert_eq!(
            held.get(&slice()).map(|claim| claim.agent.as_str()),
            Some("manager-2")
        );
        assert_eq!(released.get(&slice()), None);
    }

    #[test]
    fn renewed_keeps_the_session_and_moves_the_lease_end() {
        let claim = Claim::starting(
            agent("manager"),
            Some("session-1".to_owned()),
            Some("/logs/session-1.jsonl".to_owned()),
            at("2026-11-13T00:00:00Z"),
        );

        let renewed = claim.renewed(at("2026-11-13T01:00:00Z"));

        assert_eq!(renewed.lease_end, at("2026-11-13T05:00:00Z"));
        assert_eq!(renewed.session.as_deref(), Some("session-1"));
        assert_eq!(renewed.agent, claim.agent);
    }
}

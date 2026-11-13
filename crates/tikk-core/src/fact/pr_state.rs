use std::collections::HashMap;
use std::fmt;

use crate::fact::{FactEvent, FactLine, Timestamp};
use crate::ticket::TicketId;

const URL_START: &str = "https://github.com/";

/// A GitHub PR, named by its repository `owner/name` and its number.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PullRequest {
    repository: String,
    number: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrState {
    Open,
    Closed,
    Merged,
}

/// What `gh` showed of a PR at one time. `in_trunk` is true once the PR's work is in the trunk
/// branch of its repository.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrObservation {
    pub pull_request: PullRequest,
    pub state: PrState,
    pub base: String,
    pub head: String,
    pub merge_commit: Option<String>,
    pub in_trunk: bool,
}

/// The state tikk shows for a slice's PR, and the time of the newest `pr` fact of that PR.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShownPr {
    pub observation: PrObservation,
    pub checked_at: Timestamp,
}

impl PullRequest {
    pub(crate) fn new(repository: &str, number: u64) -> Option<Self> {
        let (owner, name) = repository.split_once('/')?;
        let valid = is_name(owner) && is_name(name) && number > 0;

        valid.then(|| Self {
            repository: repository.to_owned(),
            number,
        })
    }

    /// Reads `https://github.com/<owner>/<name>/pull/<number>`.
    pub fn from_url(url: &str) -> Option<Self> {
        let path = url.strip_prefix(URL_START)?;
        let mut parts = path.split('/');
        let (owner, name, pull, number) =
            (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
        let starts_with_zero = number.starts_with('0');

        if parts.next().is_some() || pull != "pull" || starts_with_zero {
            return None;
        }

        Self::new(&format!("{owner}/{name}"), number.parse().ok()?)
    }

    pub fn repository(&self) -> &str {
        &self.repository
    }

    pub fn number(&self) -> u64 {
        self.number
    }

    pub fn url(&self) -> String {
        format!("{URL_START}{}/pull/{}", self.repository, self.number)
    }
}

impl fmt::Display for PullRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}#{}", self.repository, self.number)
    }
}

impl PrState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Closed => "closed",
            Self::Merged => "merged",
        }
    }

    pub(crate) fn parse(text: &str) -> Option<Self> {
        match text {
            "open" => Some(Self::Open),
            "closed" => Some(Self::Closed),
            "merged" => Some(Self::Merged),
            _ => None,
        }
    }
}

impl ShownPr {
    pub fn state(&self) -> PrState {
        self.observation.state
    }
}

fn is_name(text: &str) -> bool {
    let allowed = |character: char| character.is_ascii_alphanumeric() || "-_.".contains(character);

    !text.is_empty() && text.chars().all(allowed)
}

// A ticket's PR is the one its newest `pr` fact names. Among that PR's facts, one that saw it in
// trunk wins, then one with a merge commit, then the newest, so a later read never hides a merge.
pub(crate) fn current_prs<'a>(
    facts: impl IntoIterator<Item = &'a FactLine>,
) -> HashMap<TicketId, ShownPr> {
    let mut prs: HashMap<TicketId, ShownPr> = HashMap::new();

    for fact in facts {
        let FactEvent::Pr(observation) = &fact.event else {
            continue;
        };
        let replaces = match prs.get(&fact.ticket) {
            Some(shown) if shown.observation.pull_request == observation.pull_request => {
                strength(observation) >= strength(&shown.observation)
            }
            _ => true,
        };
        let checked = ShownPr {
            observation: observation.clone(),
            checked_at: fact.at,
        };

        if replaces {
            prs.insert(fact.ticket.clone(), checked);
        } else if let Some(shown) = prs.get_mut(&fact.ticket) {
            shown.checked_at = fact.at;
        }
    }

    prs
}

fn strength(observation: &PrObservation) -> u8 {
    if observation.in_trunk {
        2
    } else if observation.merge_commit.is_some() {
        1
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::{PrObservation, PrState, PullRequest, current_prs};
    use crate::fact::{FactEvent, FactLine, Timestamp};
    use crate::ticket::TicketId;

    fn at(text: &str) -> Timestamp {
        Timestamp::parse(text).expect("a valid time")
    }

    fn slice() -> TicketId {
        TicketId::parse("tikk-abcd").expect("a valid ID")
    }

    fn pull_request(number: u64) -> PullRequest {
        PullRequest::new("owner/app", number).expect("a valid PR")
    }

    fn observed(
        number: u64,
        state: PrState,
        merge_commit: Option<&str>,
        in_trunk: bool,
    ) -> PrObservation {
        PrObservation {
            pull_request: pull_request(number),
            state,
            base: "main".to_owned(),
            head: "head".to_owned(),
            merge_commit: merge_commit.map(str::to_owned),
            in_trunk,
        }
    }

    fn fact(time: &str, observation: PrObservation) -> FactLine {
        FactLine {
            ticket: slice(),
            at: at(time),
            event: FactEvent::Pr(observation),
        }
    }

    #[test]
    fn from_url_reads_a_pull_request_url_and_refuses_others() {
        let cases = [
            (
                "https://github.com/owner/app/pull/7",
                Some(("owner/app", 7)),
            ),
            (
                "https://github.com/o.w-n_er/a.p-p_/pull/120",
                Some(("o.w-n_er/a.p-p_", 120)),
            ),
            ("https://github.com/owner/app/pull/0", None),
            ("https://github.com/owner/app/pull/07", None),
            ("https://github.com/owner/app/pull/7/files", None),
            ("https://github.com/owner/app/issues/7", None),
            ("https://github.com/owner/pull/7", None),
            ("https://github.com//app/pull/7", None),
            ("https://github.com/own er/app/pull/7", None),
            ("http://github.com/owner/app/pull/7", None),
            ("https://example.com/owner/app/pull/7", None),
            ("https://github.com/owner/app/pull/x", None),
        ];

        for (url, expected) in cases {
            let parsed = PullRequest::from_url(url);

            assert_eq!(
                parsed.as_ref().map(|pr| (pr.repository(), pr.number())),
                expected,
                "case {url}"
            );
        }
    }

    #[test]
    fn a_pull_request_names_its_url_and_itself() {
        let pr = pull_request(7);

        assert_eq!(pr.url(), "https://github.com/owner/app/pull/7");
        assert_eq!(pr.to_string(), "owner/app#7");
    }

    #[test]
    fn each_pr_state_has_its_contract_name_and_parses_back() {
        for state in [PrState::Open, PrState::Closed, PrState::Merged] {
            assert_eq!(PrState::parse(state.as_str()), Some(state));
        }

        assert_eq!(
            [PrState::Open, PrState::Closed, PrState::Merged].map(PrState::as_str),
            ["open", "closed", "merged"]
        );
        assert_eq!(PrState::parse("OPEN"), None);
    }

    #[test]
    fn the_newest_fact_of_a_pr_wins_and_sets_the_check_time() {
        let facts = [
            fact(
                "2026-11-13T01:00:00Z",
                observed(7, PrState::Open, None, false),
            ),
            fact(
                "2026-11-13T02:00:00Z",
                observed(7, PrState::Closed, None, false),
            ),
        ];

        let shown = current_prs(&facts)
            .remove(&slice())
            .expect("the slice has a PR");

        assert_eq!(shown.state(), PrState::Closed);
        assert_eq!(shown.checked_at, at("2026-11-13T02:00:00Z"));
    }

    #[test]
    fn a_fact_in_trunk_wins_then_one_with_a_merge_commit_and_the_check_time_stays_the_newest() {
        let in_trunk = observed(7, PrState::Merged, Some("merge"), true);
        let merged = observed(7, PrState::Merged, Some("merge"), false);
        let open = observed(7, PrState::Open, None, false);
        let cases = [
            (
                vec![in_trunk.clone(), merged.clone(), open.clone()],
                in_trunk.clone(),
            ),
            (vec![merged.clone(), open.clone()], merged.clone()),
            (vec![open, merged, in_trunk.clone()], in_trunk),
        ];

        for (index, (observations, expected)) in cases.into_iter().enumerate() {
            let times = [
                "2026-11-13T01:00:00Z",
                "2026-11-13T02:00:00Z",
                "2026-11-13T03:00:00Z",
            ];
            let facts: Vec<FactLine> = observations
                .into_iter()
                .zip(times)
                .map(|(observation, time)| fact(time, observation))
                .collect();
            let newest = facts.last().expect("each case has a fact").at;

            let shown = current_prs(&facts)
                .remove(&slice())
                .expect("the slice has a PR");

            assert_eq!(shown.observation, expected, "case {index}");
            assert_eq!(shown.checked_at, newest, "case {index}");
        }
    }

    #[test]
    fn a_newly_linked_pr_replaces_the_state_of_an_earlier_one() {
        let facts = [
            fact(
                "2026-11-13T01:00:00Z",
                observed(7, PrState::Merged, Some("merge"), true),
            ),
            fact(
                "2026-11-13T02:00:00Z",
                observed(8, PrState::Open, None, false),
            ),
        ];

        let shown = current_prs(&facts)
            .remove(&slice())
            .expect("the slice has a PR");

        assert_eq!(shown.observation, observed(8, PrState::Open, None, false));
    }

    #[test]
    fn claims_and_releases_give_no_pr() {
        let release = FactLine {
            ticket: slice(),
            at: at("2026-11-13T01:00:00Z"),
            event: FactEvent::Release { agent: None },
        };

        assert!(current_prs([&release]).is_empty());
    }
}

use std::collections::HashMap;
use std::fmt;

use serde::{Serialize, Serializer};

use crate::fact::{FactEvent, FactLine, Timestamp};
use crate::ticket::{TicketId, draw_code, is_code};

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct QuestionItem {
    code: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    pub item: QuestionItem,
    pub text: String,
    pub asked_at: Timestamp,
    pub answer: Option<Answer>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answer {
    pub text: String,
    pub answered_at: Timestamp,
}

impl Serialize for QuestionItem {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.code)
    }
}

impl QuestionItem {
    pub fn parse(text: &str) -> Option<Self> {
        is_code(text).then(|| Self {
            code: text.to_owned(),
        })
    }

    pub(crate) fn draw(random: &[u8]) -> Option<Self> {
        draw_code(random).map(|code| Self { code })
    }

    pub fn as_str(&self) -> &str {
        &self.code
    }
}

impl fmt::Display for QuestionItem {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.code)
    }
}

impl Question {
    pub fn is_open(&self) -> bool {
        self.answer.is_none()
    }
}

pub(crate) fn current_questions<'a>(
    facts: impl IntoIterator<Item = &'a FactLine>,
) -> HashMap<TicketId, Vec<Question>> {
    let mut questions: HashMap<TicketId, Vec<Question>> = HashMap::new();
    let mut answers: HashMap<(&TicketId, &QuestionItem), Answer> = HashMap::new();

    for fact in facts {
        match &fact.event {
            FactEvent::Question { item, text } => {
                questions
                    .entry(fact.ticket.clone())
                    .or_default()
                    .push(Question {
                        item: item.clone(),
                        text: text.clone(),
                        asked_at: fact.at,
                        answer: None,
                    });
            }
            FactEvent::Answer { item, text } => {
                answers.insert(
                    (&fact.ticket, item),
                    Answer {
                        text: text.clone(),
                        answered_at: fact.at,
                    },
                );
            }
            FactEvent::Claim(_)
            | FactEvent::Release { .. }
            | FactEvent::Pr(_)
            | FactEvent::Audit(_) => {}
        }
    }

    for (ticket, asked) in &mut questions {
        for question in asked {
            question.answer = answers.get(&(ticket, &question.item)).cloned();
        }
    }

    questions
}

#[cfg(test)]
mod tests {
    use super::{QuestionItem, current_questions};
    use crate::fact::{FactEvent, FactLine, Timestamp};
    use crate::ticket::TicketId;

    fn at(text: &str) -> Timestamp {
        Timestamp::parse(text).expect("a valid time")
    }

    fn item(text: &str) -> QuestionItem {
        QuestionItem::parse(text).expect("a valid item")
    }

    fn id(text: &str) -> TicketId {
        TicketId::parse(text).expect("a valid ID")
    }

    fn question(ticket: &str, code: &str, time: &str) -> FactLine {
        FactLine {
            ticket: id(ticket),
            at: at(time),
            event: FactEvent::Question {
                item: item(code),
                text: format!("Question {code}?"),
            },
        }
    }

    fn answer(ticket: &str, code: &str, text: &str, time: &str) -> FactLine {
        FactLine {
            ticket: id(ticket),
            at: at(time),
            event: FactEvent::Answer {
                item: item(code),
                text: text.to_owned(),
            },
        }
    }

    #[test]
    fn an_item_is_four_characters_of_the_id_alphabet() {
        let cases = [
            ("ab3x", true),
            ("abc", false),
            ("abcde", false),
            ("ABCD", false),
            ("ab0x", false),
        ];

        for (text, valid) in cases {
            assert_eq!(QuestionItem::parse(text).is_some(), valid, "case {text}");
        }
        assert_eq!(
            QuestionItem::draw(&[0, 1, 2, 3]).map(|item| item.to_string()),
            Some("3467".to_owned())
        );
        assert_eq!(QuestionItem::draw(&[0, 1, 2]), None);
    }

    #[test]
    fn questions_keep_fact_order_and_take_the_newest_answer_to_their_own_item() {
        let facts = [
            question("tikk-abcd", "aaaa", "2026-11-13T01:00:00Z"),
            answer("tikk-abcd", "aaaa", "first", "2026-11-13T02:00:00Z"),
            question("tikk-abcd", "bbbb", "2026-11-13T03:00:00Z"),
            answer("tikk-abcd", "aaaa", "second", "2026-11-13T04:00:00Z"),
            answer(
                "tikk-efgh",
                "bbbb",
                "another ticket",
                "2026-11-13T05:00:00Z",
            ),
            answer("tikk-abcd", "cccc", "no such item", "2026-11-13T06:00:00Z"),
        ];

        let mut questions = current_questions(&facts);

        let asked = questions
            .remove(&id("tikk-abcd"))
            .expect("the ticket asked");
        assert!(questions.is_empty(), "{questions:?}");
        assert_eq!(asked.len(), 2);
        assert_eq!(asked[0].item, item("aaaa"));
        assert_eq!(asked[0].text, "Question aaaa?");
        assert_eq!(asked[0].asked_at, at("2026-11-13T01:00:00Z"));
        let first = asked[0].answer.as_ref().expect("the first is answered");
        assert_eq!(first.text, "second");
        assert_eq!(first.answered_at, at("2026-11-13T04:00:00Z"));
        assert!(!asked[0].is_open());
        assert_eq!(asked[1].item, item("bbbb"));
        assert!(asked[1].is_open());
    }

    #[test]
    fn an_answer_written_before_its_question_still_answers_it() {
        let facts = [
            answer("tikk-abcd", "aaaa", "early", "2026-11-13T01:00:00Z"),
            question("tikk-abcd", "aaaa", "2026-11-13T02:00:00Z"),
        ];

        let questions = current_questions(&facts);

        let answer = questions[&id("tikk-abcd")][0].answer.as_ref();
        assert_eq!(answer.map(|answer| answer.text.as_str()), Some("early"));
    }
}

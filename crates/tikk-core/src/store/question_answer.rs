use std::path::Path;

use crate::fact::{
    Answer, FactEvent, FactLine, Question, QuestionItem, Timestamp, current_questions,
};
use crate::store::fact_files::{self, append_fact, read_facts};
use crate::store::store_lock::{self, LockAccess, StoreLock};
use crate::store::system;
use crate::store::ticket_files::read_tickets;
use crate::store::ticket_index::find_ticket;
use crate::store::{Store, StoreError};
use crate::ticket::TicketId;

#[derive(Clone, Copy)]
pub struct AnswerEffects {
    pub lock_store: fn(&Path, LockAccess) -> Result<StoreLock, StoreError>,
    pub now: fn() -> Timestamp,
    pub append_line: fn(&Path, &str) -> Result<(), StoreError>,
}

impl AnswerEffects {
    pub fn system() -> Self {
        Self {
            lock_store: store_lock::lock_store,
            now: system::now,
            append_line: fact_files::append_line,
        }
    }
}

pub fn answer_question(
    store: &Store,
    id: &TicketId,
    item: &QuestionItem,
    text: &str,
    effects: &AnswerEffects,
) -> Result<Question, StoreError> {
    let root = store.root();
    let _lock = (effects.lock_store)(root, LockAccess::Exclusive)?;

    find_ticket(&read_tickets(root)?, id)?;

    let question = current_questions(&read_facts(root)?.facts)
        .remove(id)
        .and_then(|asked| asked.into_iter().find(|question| question.item == *item))
        .ok_or_else(|| StoreError::UnknownQuestion {
            id: id.to_string(),
            item: item.to_string(),
        })?;
    let now = (effects.now)();
    let fact = FactLine {
        ticket: id.clone(),
        at: now,
        event: FactEvent::Answer {
            item: item.clone(),
            text: text.to_owned(),
        },
    };

    append_fact(root, &fact, effects.append_line)?;

    Ok(Question {
        answer: Some(Answer {
            text: text.to_owned(),
            answered_at: now,
        }),
        ..question
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{AnswerEffects, answer_question};
    use crate::fact::{FactEvent, FactLine, QuestionItem, Timestamp};
    use crate::store::fact_files::{append_fact, append_line, read_facts};
    use crate::store::{MachineName, Store, StoreEffects, StoreError, init};
    use crate::ticket::TicketId;

    fn id(text: &str) -> TicketId {
        TicketId::parse(text).expect("a valid ID")
    }

    fn item(text: &str) -> QuestionItem {
        QuestionItem::parse(text).expect("a valid item")
    }

    #[test]
    fn answer_names_an_item_another_ticket_asked_and_is_refused() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let machine = MachineName::parse("test").expect("a valid machine name");
        init(directory.path(), Some(machine), &StoreEffects::system()).expect("init the store");
        let folder = directory.path().join("tickets/personal");
        fs::create_dir_all(&folder).expect("create the project folder");
        for name in ["personal-aaaa-a.md", "personal-bbbb-b.md"] {
            fs::write(folder.join(name), "---\nkind: task\ntitle: Task\n---\n")
                .expect("write a task");
        }
        let asked = FactLine {
            ticket: id("personal-aaaa"),
            at: Timestamp::parse("2026-11-13T01:00:00Z").expect("a valid time"),
            event: FactEvent::Question {
                item: item("3333"),
                text: "Which?".to_owned(),
            },
        };
        append_fact(directory.path(), &asked, append_line).expect("append the question");
        let store = Store {
            root: directory.path().to_path_buf(),
        };

        let error = answer_question(
            &store,
            &id("personal-bbbb"),
            &item("3333"),
            "yes",
            &AnswerEffects::system(),
        )
        .expect_err("the other ticket asked it");
        let answered = answer_question(
            &store,
            &id("personal-aaaa"),
            &item("3333"),
            "yes",
            &AnswerEffects::system(),
        )
        .expect("the asking ticket takes the answer");

        assert!(
            matches!(&error, StoreError::UnknownQuestion { id, item } if id == "personal-bbbb" && item == "3333"),
            "{error:?}"
        );
        assert_eq!(answered.text, "Which?");
        assert_eq!(
            answered.answer.map(|answer| answer.text),
            Some("yes".to_owned())
        );
        assert_eq!(
            read_facts(store.root())
                .expect("read the facts")
                .facts
                .len(),
            2
        );
    }
}

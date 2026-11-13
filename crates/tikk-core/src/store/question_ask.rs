use std::path::Path;

use crate::fact::{FactEvent, FactLine, Question, QuestionItem, current_questions};
use crate::store::claim_lease::{LeaseEffects, instruction_slice, write_for_slice};
use crate::store::fact_files::{append_fact, read_facts};
use crate::store::identity::Identity;
use crate::store::store_lock::{self, LockAccess, StoreLock};
use crate::store::system;
use crate::store::ticket_files::read_tickets;
use crate::store::ticket_id_draw::{DRAW_ATTEMPTS, RANDOM_BYTES};
use crate::store::ticket_queries::find_ticket;
use crate::store::{Store, StoreError};
use crate::ticket::{Kind, TicketId};

#[derive(Clone, Copy)]
pub struct AskEffects {
    pub lock_store: fn(&Path, LockAccess) -> Result<StoreLock, StoreError>,
    pub fill_random: fn(&mut [u8]) -> Result<(), StoreError>,
    pub lease: LeaseEffects,
}

impl AskEffects {
    pub fn system() -> Self {
        Self {
            lock_store: store_lock::lock_store,
            fill_random: system::fill_random,
            lease: LeaseEffects::system(),
        }
    }
}

pub fn ask_question(
    store: &Store,
    id: &TicketId,
    text: &str,
    caller: &Identity,
    effects: &AskEffects,
) -> Result<Question, StoreError> {
    let root = store.root();
    let _lock = (effects.lock_store)(root, LockAccess::Exclusive)?;
    let scan = read_tickets(root)?;
    let fields = &find_ticket(&scan, id)?.document.fields;
    let slice = if fields.kind() == Kind::Slice {
        Some(id)
    } else {
        instruction_slice(fields)
    };

    write_for_slice(root, &scan, slice, caller, &effects.lease, || {
        append_question(root, id, text, effects)
    })
}

// The caller holds the exclusive lock.
fn append_question(
    root: &Path,
    id: &TicketId,
    text: &str,
    effects: &AskEffects,
) -> Result<Question, StoreError> {
    let asked = current_questions(&read_facts(root)?.facts)
        .remove(id)
        .unwrap_or_default();
    let item = draw_free_item(id, &asked, effects.fill_random)?;
    let now = (effects.lease.now)();
    let fact = FactLine {
        ticket: id.clone(),
        at: now,
        event: FactEvent::Question {
            item: item.clone(),
            text: text.to_owned(),
        },
    };

    append_fact(root, &fact, effects.lease.append_line)?;

    Ok(Question {
        item,
        text: text.to_owned(),
        asked_at: now,
        answer: None,
    })
}

fn draw_free_item(
    id: &TicketId,
    asked: &[Question],
    fill_random: fn(&mut [u8]) -> Result<(), StoreError>,
) -> Result<QuestionItem, StoreError> {
    for _ in 0..DRAW_ATTEMPTS {
        let mut bytes = [0u8; RANDOM_BYTES];

        fill_random(&mut bytes)?;

        if let Some(item) = QuestionItem::draw(&bytes)
            && !asked.iter().any(|question| question.item == item)
        {
            return Ok(item);
        }
    }

    Err(StoreError::NoFreeItem { id: id.to_string() })
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::fs;

    use tempfile::TempDir;

    use super::{AskEffects, ask_question};
    use std::time::SystemTime;

    use crate::fact::{AgentName, Claim, FactEvent, FactLine, Timestamp, current_questions};
    use crate::store::fact_files::{append_fact, append_line, read_facts};
    use crate::store::identity::Identity;
    use crate::store::{MachineName, Store, StoreEffects, StoreError, init};
    use crate::ticket::TicketId;

    thread_local! {
        static DRAWS: Cell<u8> = const { Cell::new(0) };
    }

    fn repeating_random(buffer: &mut [u8]) -> Result<(), StoreError> {
        let draw = DRAWS.with(|draws| {
            let draw = draws.get();
            draws.set(draw + 1);
            draw
        });

        buffer.fill(u8::from(draw >= 2));

        Ok(())
    }

    fn zero_random(buffer: &mut [u8]) -> Result<(), StoreError> {
        buffer.fill(0);

        Ok(())
    }

    fn store_with_task() -> (TempDir, Store) {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let machine = MachineName::parse("test").expect("a valid machine name");
        init(directory.path(), Some(machine), &StoreEffects::system()).expect("init the store");
        let folder = directory.path().join("tickets/personal");
        fs::create_dir_all(&folder).expect("create the project folder");
        fs::write(
            folder.join("personal-tttt-task.md"),
            "---\nkind: task\ntitle: Renew the domain\n---\n",
        )
        .expect("write the task");
        let store = Store {
            root: directory.path().to_path_buf(),
        };

        (directory, store)
    }

    fn id(text: &str) -> TicketId {
        TicketId::parse(text).expect("a valid ID")
    }

    #[test]
    fn a_new_question_draws_an_item_the_ticket_does_not_have() {
        DRAWS.set(0);
        let (_directory, store) = store_with_task();
        let effects = AskEffects {
            fill_random: repeating_random,
            ..AskEffects::system()
        };

        let first = ask_question(
            &store,
            &id("personal-tttt"),
            "Which registrar?",
            &Identity::default(),
            &effects,
        )
        .expect("the first question is asked");
        let second = ask_question(
            &store,
            &id("personal-tttt"),
            "Which year?",
            &Identity::default(),
            &effects,
        )
        .expect("the second question is asked");

        assert_eq!(first.item.as_str(), "3333");
        assert_eq!(second.item.as_str(), "4444");
        let facts = read_facts(store.root()).expect("read the facts").facts;
        let asked = &current_questions(&facts)[&id("personal-tttt")];
        assert_eq!(asked[1].text, "Which year?");
        assert!(
            matches!(&facts[1].event, FactEvent::Question { item, .. } if item.as_str() == "4444")
        );
    }

    #[test]
    fn ask_gives_up_when_every_draw_is_taken_and_writes_nothing_more() {
        let (_directory, store) = store_with_task();
        let effects = AskEffects {
            fill_random: zero_random,
            ..AskEffects::system()
        };
        let ask = || {
            ask_question(
                &store,
                &id("personal-tttt"),
                "Which registrar?",
                &Identity::default(),
                &effects,
            )
        };
        ask().expect("the first question is asked");

        let error = ask().expect_err("every draw is taken");

        assert!(
            matches!(&error, StoreError::NoFreeItem { id } if id == "personal-tttt"),
            "{error:?}"
        );
        assert_eq!(
            read_facts(store.root())
                .expect("read the facts")
                .facts
                .len(),
            1
        );
    }

    #[test]
    fn ask_by_another_agent_on_a_claimed_slice_is_refused_and_writes_nothing() {
        let (directory, store) = store_with_task();
        let folder = directory.path().join("tickets/personal");
        fs::write(
            folder.join("personal-pppp-plan.md"),
            "---\nkind: plan\ntitle: Plan\n---\n",
        )
        .expect("write the plan");
        fs::write(
            folder.join("personal-kkkk-slice.md"),
            "---\nkind: slice\ntitle: Slice\nparent: personal-pppp\ncriteria:\n  - id: s1\n    check: c\n    expected: e\n---\n",
        )
        .expect("write the slice");
        let now = Timestamp::from_system_time(SystemTime::now());
        let claim = Claim::starting(
            AgentName::parse("manager").expect("a valid name"),
            None,
            None,
            now,
        );
        let fact = FactLine {
            ticket: id("personal-kkkk"),
            at: now,
            event: FactEvent::Claim(claim),
        };
        append_fact(directory.path(), &fact, append_line).expect("append the claim");
        let other = Identity {
            agent: AgentName::parse("other"),
            ..Identity::default()
        };

        let error = ask_question(
            &store,
            &id("personal-kkkk"),
            "Which crate?",
            &other,
            &AskEffects::system(),
        )
        .expect_err("another agent holds the slice");

        assert!(
            matches!(&error, StoreError::Claimed { agent, .. } if agent == "manager"),
            "{error:?}"
        );
        assert_eq!(
            read_facts(store.root())
                .expect("read the facts")
                .facts
                .len(),
            1
        );
    }
}

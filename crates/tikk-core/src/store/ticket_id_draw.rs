use std::collections::HashSet;
use std::path::Path;

use crate::store::StoreError;
use crate::store::ticket_create::TicketEffects;
use crate::store::ticket_files::{exists, is_folder, sorted_entries};
use crate::ticket::{ProjectName, TicketId};

const DRAW_ATTEMPTS: usize = 100;
const RANDOM_BYTES: usize = 16;

pub(crate) fn draw_free_id(
    project: &ProjectName,
    folder: &Path,
    effects: &TicketEffects,
) -> Result<TicketId, StoreError> {
    let taken = taken_ids(project, folder)?;

    for _ in 0..DRAW_ATTEMPTS {
        let mut bytes = [0u8; RANDOM_BYTES];

        (effects.fill_random)(&mut bytes)?;

        if let Some(id) = TicketId::draw(project, &bytes)
            && !taken.contains(&id)
        {
            return Ok(id);
        }
    }

    Err(StoreError::NoFreeId {
        project: project.to_string(),
    })
}

/// The IDs of the ticket files and ticket folders in a project folder.
fn taken_ids(project: &ProjectName, folder: &Path) -> Result<HashSet<TicketId>, StoreError> {
    let mut taken = HashSet::new();

    if !exists(folder)? {
        return Ok(taken);
    }

    for path in sorted_entries(folder)? {
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        let id = if is_folder(&path)? {
            TicketId::parse(&name)
                .ok()
                .filter(|id| id.project() == project)
        } else {
            TicketId::from_file_name(project, &name)
        };

        taken.extend(id);
    }

    Ok(taken)
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::fs;
    use std::path::Path;

    use super::draw_free_id;
    use crate::store::ticket_create::TicketEffects;
    use crate::store::{StoreError, system};
    use crate::ticket::{ID_ALPHABET, ProjectName};

    thread_local! {
        static DRAWS: Cell<u8> = const { Cell::new(0) };
    }

    fn no_origin(_: &Path) -> Result<Option<String>, StoreError> {
        Ok(None)
    }

    /// Each call fills the buffer with the next byte value: 0 gives `3333`, 1 gives `4444`.
    fn counting_random(buffer: &mut [u8]) -> Result<(), StoreError> {
        let value = DRAWS.with(|draws| {
            let value = draws.get();
            draws.set(value + 1);
            value
        });

        buffer.fill(value);

        Ok(())
    }

    fn zero_random(buffer: &mut [u8]) -> Result<(), StoreError> {
        buffer.fill(0);

        Ok(())
    }

    fn effects(fill_random: fn(&mut [u8]) -> Result<(), StoreError>) -> TicketEffects {
        TicketEffects {
            read_origin_url: no_origin,
            fill_random,
        }
    }

    fn project(name: &str) -> ProjectName {
        ProjectName::parse(name).expect("a valid project name")
    }

    #[test]
    fn draw_free_id_draws_again_when_a_file_or_folder_has_the_id() {
        DRAWS.set(0);
        let directory = tempfile::tempdir().expect("create a temporary directory");
        fs::write(directory.path().join("personal-3333-taken.md"), "").expect("write a file");
        fs::create_dir(directory.path().join("personal-4444")).expect("create a folder");

        let id = draw_free_id(
            &project("personal"),
            directory.path(),
            &effects(counting_random),
        )
        .expect("a free ID exists");

        assert_eq!(id.to_string(), "personal-6666");
    }

    #[test]
    fn draw_free_id_gives_up_when_every_draw_is_taken() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        fs::write(directory.path().join("personal-3333.md"), "").expect("write a file");
        let always_taken = effects(zero_random);

        let error = draw_free_id(&project("personal"), directory.path(), &always_taken)
            .expect_err("every draw is taken");

        assert!(
            matches!(&error, StoreError::NoFreeId { project } if project == "personal"),
            "{error:?}"
        );
    }

    #[test]
    fn ten_thousand_ids_from_the_system_source_use_only_the_alphabet() {
        let directory = tempfile::tempdir().expect("create a temporary directory");
        let system_effects = effects(system::fill_random);

        for _ in 0..10_000 {
            let id = draw_free_id(&project("personal"), directory.path(), &system_effects)
                .expect("an ID is drawn");
            let text = id.to_string();
            let code = text
                .strip_prefix("personal-")
                .expect("the ID starts with the project");

            assert_eq!(code.len(), 4, "{text}");
            assert!(
                code.chars()
                    .all(|character| ID_ALPHABET.contains(character)),
                "{text}"
            );
        }
    }
}

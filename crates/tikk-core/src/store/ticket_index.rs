use std::collections::HashMap;
use std::path::Path;

use crate::store::StoreError;
use crate::store::ticket_files::{StoredTicket, TicketScan, UnreadableTicket};
use crate::ticket::TicketId;

pub(crate) enum TicketLookup<'a> {
    Found(&'a StoredTicket),
    Unreadable(&'a UnreadableTicket),
    Shared(Vec<&'a Path>),
    Missing,
}

#[derive(Clone, Copy)]
enum TicketEntry<'a> {
    Parsed(&'a StoredTicket),
    Broken(&'a UnreadableTicket),
}

pub(crate) struct TicketIndex<'a> {
    entries: HashMap<&'a TicketId, Vec<TicketEntry<'a>>>,
}

impl<'a> TicketIndex<'a> {
    pub(crate) fn new(scan: &'a TicketScan) -> Self {
        let mut entries: HashMap<&TicketId, Vec<TicketEntry<'a>>> = HashMap::new();

        for (id, entry) in scan_entries(scan) {
            entries.entry(id).or_default().push(entry);
        }

        Self { entries }
    }

    pub(crate) fn look_up(&self, id: &TicketId) -> TicketLookup<'a> {
        classify(self.entries.get(id).map_or(&[][..], Vec::as_slice))
    }

    pub(crate) fn shared(&self) -> Vec<(&'a TicketId, Vec<&'a Path>)> {
        let mut shared: Vec<(&TicketId, Vec<&Path>)> = self
            .entries
            .iter()
            .filter_map(|(id, entries)| match classify(entries) {
                TicketLookup::Shared(paths) => Some((*id, paths)),
                _ => None,
            })
            .collect();

        shared.sort_by_key(|(id, _)| *id);

        shared
    }
}

fn look_up_ticket<'a>(scan: &'a TicketScan, id: &TicketId) -> TicketLookup<'a> {
    let entries: Vec<TicketEntry<'a>> = scan_entries(scan)
        .filter(|(entry_id, _)| *entry_id == id)
        .map(|(_, entry)| entry)
        .collect();

    classify(&entries)
}

pub(crate) fn find_ticket<'a>(
    scan: &'a TicketScan,
    id: &TicketId,
) -> Result<&'a StoredTicket, StoreError> {
    match look_up_ticket(scan, id) {
        TicketLookup::Found(ticket) => Ok(ticket),
        TicketLookup::Unreadable(error) => Err(StoreError::TicketParse {
            path: error.path.clone(),
            message: error.message.clone(),
        }),
        TicketLookup::Shared(paths) => Err(shared(id, &paths)),
        TicketLookup::Missing => Err(StoreError::NotFound { id: id.to_string() }),
    }
}

pub(crate) fn ticket_path<'a>(scan: &'a TicketScan, id: &TicketId) -> Result<&'a Path, StoreError> {
    match look_up_ticket(scan, id) {
        TicketLookup::Found(ticket) => Ok(&ticket.path),
        TicketLookup::Unreadable(error) => Ok(&error.path),
        TicketLookup::Shared(paths) => Err(shared(id, &paths)),
        TicketLookup::Missing => Err(StoreError::NotFound { id: id.to_string() }),
    }
}

// Parsed files come before broken ones, which keeps the order of the paths of a shared ID.
fn scan_entries(scan: &TicketScan) -> impl Iterator<Item = (&TicketId, TicketEntry<'_>)> {
    let parsed = scan
        .tickets
        .iter()
        .map(|ticket| (&ticket.id, TicketEntry::Parsed(ticket)));
    let broken = scan
        .errors
        .iter()
        .filter_map(|error| error.id.as_ref().map(|id| (id, TicketEntry::Broken(error))));

    parsed.chain(broken)
}

fn classify<'a>(entries: &[TicketEntry<'a>]) -> TicketLookup<'a> {
    match entries {
        [] => TicketLookup::Missing,
        [TicketEntry::Parsed(ticket)] => TicketLookup::Found(ticket),
        [TicketEntry::Broken(error)] => TicketLookup::Unreadable(error),
        _ => TicketLookup::Shared(
            entries
                .iter()
                .map(|entry| match entry {
                    TicketEntry::Parsed(ticket) => ticket.path.as_path(),
                    TicketEntry::Broken(error) => error.path.as_path(),
                })
                .collect(),
        ),
    }
}

pub(crate) fn shared(id: &TicketId, paths: &[&Path]) -> StoreError {
    StoreError::IdShared {
        id: id.to_string(),
        paths: paths.iter().map(|path| path.to_path_buf()).collect(),
    }
}

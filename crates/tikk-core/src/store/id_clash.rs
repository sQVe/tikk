use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::store::ticket_files::TicketScan;
use crate::store::ticket_index::TicketIndex;
use crate::ticket::TicketId;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdClash {
    pub id: TicketId,
    pub paths: Vec<PathBuf>,
}

impl Serialize for IdClash {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct as _;

        let paths: Vec<String> = self
            .paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        let mut clash = serializer.serialize_struct("IdClash", 2)?;

        clash.serialize_field("id", &self.id)?;
        clash.serialize_field("paths", &paths)?;
        clash.end()
    }
}

pub(crate) fn id_clashes(scan: &TicketScan) -> Vec<IdClash> {
    TicketIndex::new(scan)
        .shared()
        .into_iter()
        .map(|(id, paths)| IdClash {
            id: id.clone(),
            paths: paths.into_iter().map(Path::to_path_buf).collect(),
        })
        .collect()
}

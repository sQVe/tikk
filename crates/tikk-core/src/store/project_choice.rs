use std::path::Path;

use crate::store::StoreError;
use crate::ticket::ProjectName;

pub(crate) fn choose_project(
    requested: Option<ProjectName>,
    working_directory: &Path,
    read_origin_url: fn(&Path) -> Result<Option<String>, StoreError>,
) -> Result<ProjectName, StoreError> {
    if let Some(requested) = requested {
        return Ok(requested);
    }

    match read_origin_url(working_directory)? {
        None => Ok(ProjectName::personal()),
        Some(url) => {
            ProjectName::from_origin_url(&url).map_err(|_| StoreError::InvalidOrigin { url })
        }
    }
}

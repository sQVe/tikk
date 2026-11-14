use crate::ticket::{Kind, TicketError, TicketFields, TicketId};

impl TicketFields {
    pub fn check_links(
        &self,
        kind_of: impl Fn(&TicketId) -> Option<Kind>,
    ) -> Result<(), TicketError> {
        if let Some(parent) = self.parent() {
            let parent_kind = kind_of(parent).ok_or_else(|| missing("parent", parent))?;

            if !allows_parent(self.kind(), parent_kind) {
                return Err(TicketError::invalid(
                    "parent",
                    format!(
                        "names {parent}, a {parent_kind}, but a {} cannot sit under a {parent_kind}",
                        self.kind()
                    ),
                ));
            }
        }

        let edges = [
            ("blockedBy", self.blocked_by()),
            (
                "discoveredFrom",
                self.discovered_from().map_or(&[][..], std::slice::from_ref),
            ),
            ("related", self.related()),
        ];

        for (field, targets) in edges {
            if let Some(target) = targets.iter().find(|target| kind_of(target).is_none()) {
                return Err(missing(field, target));
            }
        }

        Ok(())
    }
}

impl TicketFields {
    pub(crate) fn check_child(
        &self,
        child: &TicketId,
        child_kind: Kind,
    ) -> Result<(), TicketError> {
        if allows_parent(child_kind, self.kind()) {
            return Ok(());
        }

        Err(TicketError::invalid(
            "kind",
            format!(
                "is {}, but its child {child}, a {child_kind}, cannot sit under a {}",
                self.kind(),
                self.kind()
            ),
        ))
    }

    pub(crate) fn linked_ids(&self) -> impl Iterator<Item = &TicketId> {
        self.parent()
            .into_iter()
            .chain(self.blocked_by())
            .chain(self.discovered_from())
            .chain(self.related())
    }
}

fn allows_parent(kind: Kind, parent: Kind) -> bool {
    matches!(
        (kind, parent),
        (Kind::Slice, Kind::Plan) | (Kind::Instruction, Kind::Slice) | (Kind::Task, Kind::Plan)
    )
}

fn missing(field: &str, target: &TicketId) -> TicketError {
    TicketError::invalid(field, format!("names {target}, but no ticket has that ID"))
}

#[cfg(test)]
mod tests {
    use crate::ticket::{Kind, TicketDocument, TicketError, TicketId};

    fn id(text: &str) -> TicketId {
        TicketId::parse(text).expect("a valid ID")
    }

    fn store(id_text: &str) -> Option<Kind> {
        match id_text {
            "personal-pppp" => Some(Kind::Plan),
            "personal-kkkk" => Some(Kind::Slice),
            "personal-tttt" => Some(Kind::Task),
            _ => None,
        }
    }

    fn check(document: &str) -> Result<(), TicketError> {
        let parsed = TicketDocument::parse(document).expect("the document is valid on its own");

        parsed
            .fields
            .check_links(|target| store(&target.to_string()))
    }

    fn field_of(result: Result<(), TicketError>) -> String {
        match result {
            Err(TicketError::Invalid { field, .. }) => field,
            other => panic!("not a validation error: {other:?}"),
        }
    }

    #[test]
    fn a_wrong_parent_kind_names_the_parent_field() {
        let cases = [
            "---\nkind: task\ntitle: T\nparent: personal-kkkk\n---\n",
            "---\nkind: slice\ntitle: S\nparent: personal-kkkk\n---\n",
            "---\nkind: instruction\ntitle: I\nparent: personal-pppp\n---\n",
            "---\nkind: slice\ntitle: S\nparent: personal-tttt\n---\n",
        ];

        for document in cases {
            assert_eq!(field_of(check(document)), "parent", "case {document}");
        }
    }

    #[test]
    fn an_edge_to_a_missing_ticket_names_its_field() {
        let cases = [
            (
                "---\nkind: task\ntitle: T\nparent: personal-zzzz\n---\n",
                "parent",
            ),
            (
                "---\nkind: task\ntitle: T\nblockedBy: [personal-tttt, personal-zzzz]\n---\n",
                "blockedBy",
            ),
            (
                "---\nkind: task\ntitle: T\ndiscoveredFrom: personal-zzzz\n---\n",
                "discoveredFrom",
            ),
            (
                "---\nkind: task\ntitle: T\nrelated: [personal-zzzz]\n---\n",
                "related",
            ),
        ];

        for (document, field) in cases {
            assert_eq!(field_of(check(document)), field, "case {document}");
        }
    }

    #[test]
    fn linked_ids_names_the_parent_and_every_edge_target() {
        let document = TicketDocument::parse(
            "---\nkind: task\ntitle: T\nparent: personal-pppp\nblockedBy: [personal-3333]\ndiscoveredFrom: personal-4444\nrelated: [personal-6666]\n---\n",
        )
        .expect("the document parses");

        let linked: Vec<String> = document
            .fields
            .linked_ids()
            .map(ToString::to_string)
            .collect();

        assert_eq!(
            linked,
            [
                "personal-pppp",
                "personal-3333",
                "personal-4444",
                "personal-6666"
            ]
        );
    }

    #[test]
    fn valid_parents_and_edges_pass() {
        let cases = [
            "---\nkind: slice\ntitle: S\nparent: personal-pppp\nblockedBy: [personal-kkkk]\n---\n",
            "---\nkind: instruction\ntitle: I\nparent: personal-kkkk\n---\n",
            "---\nkind: task\ntitle: T\nparent: personal-pppp\nrelated: [personal-tttt]\n---\n",
            "---\nkind: task\ntitle: T\ndiscoveredFrom: personal-kkkk\n---\n",
        ];

        for document in cases {
            assert_eq!(check(document), Ok(()), "case {document}");
        }
    }

    #[test]
    fn the_missing_target_is_named_in_the_problem() {
        let error = check("---\nkind: task\ntitle: T\nblockedBy: [personal-zzzz]\n---\n")
            .expect_err("the blocker is missing");

        assert_eq!(
            error,
            TicketError::invalid(
                "blockedBy",
                format!("names {}, but no ticket has that ID", id("personal-zzzz"))
            )
        );
    }
}

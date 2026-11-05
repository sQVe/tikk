use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::Value;

type Graph = BTreeMap<String, Vec<String>>;

const PROTECTED_PACKAGES: &[&str] = &["tikk-cli", "tikk-core"];

pub(crate) fn check(root: &Path) -> Result<(), String> {
    let metadata = read_metadata(root)?;
    let violations = boundary_violations(&metadata)?;

    if violations.is_empty() {
        return Ok(());
    }

    Err(violations.join("\n"))
}

fn read_metadata(root: &Path) -> Result<Value, String> {
    let output = Command::new("cargo")
        .args(["metadata", "--format-version", "1", "--locked"])
        .current_dir(root)
        .stderr(Stdio::inherit())
        .output()
        .map_err(|error| format!("Could not start cargo metadata: {error}"))?;

    if !output.status.success() {
        return Err(format!("cargo metadata failed with {}.", output.status));
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("cargo metadata printed invalid JSON: {error}"))
}

fn is_forbidden(package: &str) -> bool {
    package.starts_with("gpui") || package == "tikk-ui" || package == "tikk-desktop"
}

fn package_names(metadata: &Value) -> Result<BTreeMap<&str, &str>, String> {
    let packages = metadata["packages"]
        .as_array()
        .ok_or("cargo metadata has no packages list.")?;

    packages
        .iter()
        .map(|package| {
            let id = package["id"].as_str().ok_or("A package has no id.")?;
            let name = package["name"].as_str().ok_or("A package has no name.")?;

            Ok((id, name))
        })
        .collect()
}

fn read_graph(metadata: &Value) -> Result<Graph, String> {
    let nodes = metadata["resolve"]["nodes"]
        .as_array()
        .ok_or("cargo metadata has no resolve graph.")?;

    nodes
        .iter()
        .map(|node| {
            let id = node["id"]
                .as_str()
                .ok_or("A resolved package has no id.")?
                .to_string();
            let dependencies = node["dependencies"]
                .as_array()
                .ok_or("A resolved package has no dependency list.")?
                .iter()
                .map(|dependency| {
                    dependency
                        .as_str()
                        .map(str::to_string)
                        .ok_or_else(|| "A dependency has no id.".to_string())
                })
                .collect::<Result<Vec<String>, String>>()?;

            Ok((id, dependencies))
        })
        .collect()
}

fn path_to(previous: &BTreeMap<&str, &str>, start: &str, target: &str) -> Vec<String> {
    let mut path = vec![target];
    let mut current = target;

    while current != start {
        current = previous[current];
        path.push(current);
    }

    path.reverse();
    path.into_iter().map(str::to_string).collect()
}

fn find_forbidden_path(
    graph: &Graph,
    names: &BTreeMap<&str, &str>,
    start: &str,
) -> Option<Vec<String>> {
    let mut previous: BTreeMap<&str, &str> = BTreeMap::new();
    let mut visited: BTreeSet<&str> = BTreeSet::from([start]);
    let mut queue = VecDeque::from([start]);

    while let Some(package) = queue.pop_front() {
        let name = names.get(package).copied();
        if name.is_some_and(is_forbidden) {
            return Some(path_to(&previous, start, package));
        }

        for dependency in graph.get(package).into_iter().flatten().map(String::as_str) {
            if visited.insert(dependency) {
                previous.insert(dependency, package);
                queue.push_back(dependency);
            }
        }
    }

    None
}

fn violation_message(
    graph: &Graph,
    names: &BTreeMap<&str, &str>,
    protected: &str,
) -> Option<String> {
    let path = find_forbidden_path(graph, names, protected)?;
    let forbidden = path.last()?;
    let protected_name = names[protected];
    let forbidden_name = names[forbidden.as_str()];
    let names_path = path.iter().map(|id| names[id.as_str()]).collect::<Vec<_>>();

    Some(format!(
        "{protected_name} must not depend on {forbidden_name}: {}",
        names_path.join(" -> ")
    ))
}

fn protected_package_ids<'a>(names: &BTreeMap<&'a str, &'a str>) -> Vec<&'a str> {
    let mut ids = Vec::new();

    for protected in PROTECTED_PACKAGES {
        ids.extend(
            names
                .iter()
                .filter(|(_, name)| *name == protected)
                .map(|(id, _)| *id),
        );
    }

    ids
}

fn boundary_violations(metadata: &Value) -> Result<Vec<String>, String> {
    let names = package_names(metadata)?;
    let graph = read_graph(metadata)?;
    let protected = protected_package_ids(&names);

    Ok(protected
        .iter()
        .copied()
        .filter_map(|protected| violation_message(&graph, &names, protected))
        .collect())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::iter;

    use serde_json::{Value, json};

    use super::{boundary_violations, find_forbidden_path, is_forbidden};

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn graph(edges: &[(&str, &[&str])]) -> super::Graph {
        edges
            .iter()
            .map(|(package, dependencies)| (package.to_string(), strings(dependencies)))
            .collect::<BTreeMap<_, _>>()
    }

    fn name_map<'a>(edges: &[(&'a str, &'a [&'a str])]) -> BTreeMap<&'a str, &'a str> {
        edges
            .iter()
            .flat_map(|(package, dependencies)| {
                iter::once(*package).chain(dependencies.iter().copied())
            })
            .map(|name| (name, name))
            .collect()
    }

    fn metadata_with_ids(packages: &[(&str, &str, &[&str])]) -> Value {
        let mut names: BTreeMap<&str, &str> = BTreeMap::new();

        for &(id, name, _) in packages {
            names.insert(id, name);
        }

        for &(_, _, dependencies) in packages {
            for &dependency in dependencies {
                names.entry(dependency).or_insert(dependency);
            }
        }

        let package_entries: Vec<Value> = names
            .iter()
            .map(|(id, name)| json!({ "id": id, "name": name }))
            .collect();
        let nodes: Vec<Value> = packages
            .iter()
            .map(|(id, _, dependencies)| json!({ "id": id, "dependencies": dependencies }))
            .collect();

        json!({ "packages": package_entries, "resolve": { "nodes": nodes } })
    }

    fn metadata(edges: &[(&str, &[&str])]) -> Value {
        let packages: Vec<(&str, &str, &[&str])> = edges
            .iter()
            .map(|(package, dependencies)| (*package, *package, *dependencies))
            .collect();

        metadata_with_ids(&packages)
    }

    #[test]
    fn gpui_packages_and_ui_crates_are_forbidden() {
        assert!(is_forbidden("gpui"));
        assert!(is_forbidden("gpui-component"));
        assert!(is_forbidden("gpui_macros"));
        assert!(is_forbidden("tikk-ui"));
        assert!(is_forbidden("tikk-desktop"));
        assert!(!is_forbidden("tikk-core"));
        assert!(!is_forbidden("clap"));
    }

    #[test]
    fn finds_a_transitive_path_to_a_forbidden_package() {
        let edges: &[(&str, &[&str])] = &[
            ("tikk-cli", &["clap"]),
            ("clap", &["gpui-component"]),
            ("gpui-component", &[]),
        ];
        let graph = graph(edges);

        assert_eq!(
            find_forbidden_path(&graph, &name_map(edges), "tikk-cli"),
            Some(strings(&["tikk-cli", "clap", "gpui-component"]))
        );
    }

    #[test]
    fn finds_no_path_when_no_forbidden_package_is_reachable() {
        let edges: &[(&str, &[&str])] = &[("tikk-cli", &["clap"]), ("clap", &["serde"])];
        let graph = graph(edges);

        assert_eq!(
            find_forbidden_path(&graph, &name_map(edges), "tikk-cli"),
            None
        );
    }

    #[test]
    fn terminates_on_dependency_cycles() {
        let edges: &[(&str, &[&str])] = &[("tikk-cli", &["a"]), ("a", &["tikk-cli", "gpui"])];
        let graph = graph(edges);

        assert_eq!(
            find_forbidden_path(&graph, &name_map(edges), "tikk-cli"),
            Some(strings(&["tikk-cli", "a", "gpui"]))
        );
    }

    #[test]
    fn violation_names_the_protected_crate_and_the_path() {
        let metadata = metadata(&[
            ("tikk-cli", &["clap", "tikk-ui"]),
            ("tikk-ui", &["gpui"]),
            ("gpui", &[]),
        ]);

        assert_eq!(
            boundary_violations(&metadata),
            Ok(strings(&[
                "tikk-cli must not depend on tikk-ui: tikk-cli -> tikk-ui"
            ]))
        );
    }

    #[test]
    fn violation_reports_a_transitive_gpui_dependency_of_core() {
        let metadata = metadata(&[
            ("tikk-core", &["serde"]),
            ("serde", &["gpui_macros"]),
            ("gpui_macros", &[]),
        ]);

        assert_eq!(
            boundary_violations(&metadata),
            Ok(strings(&[
                "tikk-core must not depend on gpui_macros: tikk-core -> serde -> gpui_macros",
            ]))
        );
    }

    #[test]
    fn distinct_versions_of_one_crate_keep_their_own_dependencies() {
        let metadata = metadata_with_ids(&[
            ("tikk-cli", "tikk-cli", &["foo 1.0.0"]),
            ("foo 1.0.0", "foo", &["gpui"]),
            ("foo 2.0.0", "foo", &[]),
            ("gpui", "gpui", &[]),
        ]);

        assert_eq!(
            boundary_violations(&metadata),
            Ok(strings(&[
                "tikk-cli must not depend on gpui: tikk-cli -> foo -> gpui",
            ]))
        );
    }

    #[test]
    fn protected_package_is_found_by_name_with_a_distinct_id() {
        let metadata = metadata_with_ids(&[("tikk-cli 1.2.3", "tikk-cli", &["gpui"])]);

        assert_eq!(
            boundary_violations(&metadata),
            Ok(strings(&[
                "tikk-cli must not depend on gpui: tikk-cli -> gpui",
            ]))
        );
    }

    #[test]
    fn clean_graph_has_no_violations() {
        let metadata = metadata(&[
            ("tikk-cli", &["clap", "tikk-core"]),
            ("tikk-core", &[]),
            ("tikk-desktop", &["tikk-core", "tikk-ui"]),
            ("tikk-ui", &[]),
        ]);

        assert_eq!(boundary_violations(&metadata), Ok(vec![]));
    }
}

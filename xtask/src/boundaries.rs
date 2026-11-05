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

fn resolve_name(names: &BTreeMap<&str, &str>, id: &Value) -> Result<String, String> {
    let id = id.as_str().ok_or("A dependency has no id.")?;

    names
        .get(id)
        .map(|name| name.to_string())
        .ok_or_else(|| format!("cargo metadata has no package for {id}."))
}

fn read_graph(metadata: &Value) -> Result<Graph, String> {
    let names = package_names(metadata)?;
    let nodes = metadata["resolve"]["nodes"]
        .as_array()
        .ok_or("cargo metadata has no resolve graph.")?;

    nodes
        .iter()
        .map(|node| {
            let name = resolve_name(&names, &node["id"])?;
            let dependencies = node["dependencies"]
                .as_array()
                .ok_or("A resolved package has no dependency list.")?
                .iter()
                .map(|dependency| resolve_name(&names, dependency))
                .collect::<Result<Vec<String>, String>>()?;

            Ok((name, dependencies))
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

fn find_forbidden_path(graph: &Graph, start: &str) -> Option<Vec<String>> {
    let mut previous: BTreeMap<&str, &str> = BTreeMap::new();
    let mut visited: BTreeSet<&str> = BTreeSet::from([start]);
    let mut queue = VecDeque::from([start]);

    while let Some(package) = queue.pop_front() {
        if is_forbidden(package) {
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

fn violation_message(graph: &Graph, protected: &str) -> Option<String> {
    let path = find_forbidden_path(graph, protected)?;
    let forbidden = path.last()?;

    Some(format!(
        "{protected} must not depend on {forbidden}: {}",
        path.join(" -> ")
    ))
}

fn boundary_violations(metadata: &Value) -> Result<Vec<String>, String> {
    let graph = read_graph(metadata)?;

    Ok(PROTECTED_PACKAGES
        .iter()
        .filter_map(|protected| violation_message(&graph, protected))
        .collect())
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};
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

    fn metadata(edges: &[(&str, &[&str])]) -> Value {
        let names: BTreeSet<&str> = edges
            .iter()
            .flat_map(|(package, dependencies)| {
                iter::once(*package).chain(dependencies.iter().copied())
            })
            .collect();
        let packages: Vec<Value> = names
            .iter()
            .map(|name| json!({ "id": name, "name": name }))
            .collect();
        let nodes: Vec<Value> = edges
            .iter()
            .map(|(package, dependencies)| json!({ "id": package, "dependencies": dependencies }))
            .collect();

        json!({ "packages": packages, "resolve": { "nodes": nodes } })
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
        let graph = graph(&[
            ("tikk-cli", &["clap"]),
            ("clap", &["gpui-component"]),
            ("gpui-component", &[]),
        ]);

        assert_eq!(
            find_forbidden_path(&graph, "tikk-cli"),
            Some(strings(&["tikk-cli", "clap", "gpui-component"]))
        );
    }

    #[test]
    fn finds_no_path_when_no_forbidden_package_is_reachable() {
        let graph = graph(&[("tikk-cli", &["clap"]), ("clap", &["serde"])]);

        assert_eq!(find_forbidden_path(&graph, "tikk-cli"), None);
    }

    #[test]
    fn terminates_on_dependency_cycles() {
        let graph = graph(&[("tikk-cli", &["a"]), ("a", &["tikk-cli", "gpui"])]);

        assert_eq!(
            find_forbidden_path(&graph, "tikk-cli"),
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

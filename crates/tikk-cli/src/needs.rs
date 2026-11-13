use std::path::PathBuf;

use serde_json::{Value, json};
use tikk_core::{
    Attention, AttentionItem, AttentionProblem, AttentionReason, QueryEffects, Store, StoreError,
    TicketId,
};

use crate::output::Output;
use crate::pr::{pr_json, pr_text};

pub(crate) fn run(store: &Store, effects: &QueryEffects) -> Result<Output, StoreError> {
    let attention = tikk_core::read_attention(store, effects)?;

    Ok(Output {
        json: attention_json(&attention),
        text: attention_text(&attention),
    })
}

fn attention_json(attention: &Attention) -> Value {
    let items: Vec<Value> = attention.items.iter().map(item_json).collect();
    let problems: Vec<Value> = attention.problems.iter().map(problem_json).collect();

    json!({ "items": items, "problems": problems })
}

fn item_json(item: &AttentionItem) -> Value {
    let mut json = json!({ "reason": item.reason.as_str(), "id": item.id.to_string() });

    match &item.reason {
        AttentionReason::Question { item, text } => {
            json["item"] = json!(item.as_str());
            json["text"] = json!(text);
        }
        AttentionReason::StaleClaim { holder, lease_end } => {
            json["holder"] = json!(holder.as_str());
            json["leaseEnd"] = json!(lease_end.to_string());
        }
        AttentionReason::BlockingTask { blocks } => json["blocks"] = json!(blocks),
        AttentionReason::LooseTask => {}
        AttentionReason::MergedUnverified { pr } => {
            json["pr"] = pr_json(pr);
            json["prCheckedAt"] = json!(pr.checked_at.to_string());
        }
    }

    json
}

fn problem_json(problem: &AttentionProblem) -> Value {
    let mut json = match problem {
        AttentionProblem::TicketUnreadable { path, message }
        | AttentionProblem::SyncResultUnreadable { path, message } => {
            json!({ "path": path.to_string_lossy(), "message": message })
        }
        AttentionProblem::IdShared { id, paths } => {
            let shown: Vec<String> = paths
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect();

            json!({ "id": id.to_string(), "paths": shown, "message": shared_message(id, paths) })
        }
        AttentionProblem::FactUnreadable {
            path,
            line,
            message,
        } => json!({ "path": path.to_string_lossy(), "line": line, "message": message }),
        AttentionProblem::SyncFailed { at, message, files } => {
            json!({ "at": at, "message": message, "files": files })
        }
        AttentionProblem::SyncProblem {
            at,
            step,
            message,
            files,
        } => json!({ "at": at, "step": step, "message": message, "files": files }),
    };

    json["code"] = json!(problem.code());

    json
}

fn shared_message(id: &TicketId, paths: &[PathBuf]) -> String {
    StoreError::IdShared {
        id: id.to_string(),
        paths: paths.to_vec(),
    }
    .to_string()
}

fn attention_text(attention: &Attention) -> String {
    let items = attention.items.iter().map(item_text);
    let problems = attention.problems.iter().map(problem_text);
    let lines: Vec<String> = items.chain(problems).collect();

    if lines.is_empty() {
        return "Nothing waits on you.".to_owned();
    }

    lines.join("\n")
}

fn item_text(item: &AttentionItem) -> String {
    let detail = match &item.reason {
        AttentionReason::Question { item, text } => format!(" {item}: {text}"),
        AttentionReason::StaleClaim { holder, lease_end } => {
            format!(": {holder}, lease ended {lease_end}")
        }
        AttentionReason::BlockingTask { blocks } => {
            let blocks: Vec<String> = blocks.iter().map(ToString::to_string).collect();

            format!(": blocks {}", blocks.join(", "))
        }
        AttentionReason::LooseTask => String::new(),
        AttentionReason::MergedUnverified { pr } => format!(": {}", pr_text(pr)),
    };

    format!("{}  {}{detail}", item.id, item.reason.as_str())
}

fn problem_text(problem: &AttentionProblem) -> String {
    let place = match problem {
        AttentionProblem::TicketUnreadable { path, .. }
        | AttentionProblem::SyncResultUnreadable { path, .. } => path.display().to_string(),
        AttentionProblem::IdShared { paths, .. } => paths
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join("  "),
        AttentionProblem::FactUnreadable { path, line, .. } => {
            format!("{}:{line}", path.display())
        }
        AttentionProblem::SyncFailed { files, .. }
        | AttentionProblem::SyncProblem { files, .. } => files.join("  "),
    };
    let message = match problem {
        AttentionProblem::TicketUnreadable { message, .. }
        | AttentionProblem::SyncResultUnreadable { message, .. }
        | AttentionProblem::FactUnreadable { message, .. }
        | AttentionProblem::SyncFailed { message, .. }
        | AttentionProblem::SyncProblem { message, .. } => message.clone(),
        AttentionProblem::IdShared { id, paths } => shared_message(id, paths),
    };

    if place.is_empty() {
        format!("problem {}: {message}", problem.code())
    } else {
        format!("problem {}: {place}: {message}", problem.code())
    }
}

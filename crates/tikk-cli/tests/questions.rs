mod support;

use std::path::Path;

use serde_json::{Value, json};

use support::{Home, parse_json};

fn needs_items(home: &Home) -> Vec<Value> {
    let run = home.tikk(&["needs", "--json"]);

    assert_eq!(run.exit_code, 0, "needs: {}", run.stderr);

    parse_json(&run.stdout)["items"]
        .as_array()
        .expect("needs lists items")
        .clone()
}

fn ask(home: &Home, agent: Option<&str>, id: &str, text: &str) -> Value {
    let arguments = ["ask", id, "--text", text, "--json"];
    let run = match agent {
        Some(agent) => home.tikk_as(agent, &arguments),
        None => home.tikk(&arguments),
    };

    assert_eq!(run.exit_code, 0, "ask: {}", run.stderr);

    parse_json(&run.stdout)
}

fn claim_live(home: &Home, slice: &str, agent: &str) -> Value {
    let run = home.tikk_as(agent, &["claim", slice, "--json"]);

    assert_eq!(run.exit_code, 0, "claim: {}", run.stderr);

    parse_json(&run.stdout)["claim"].clone()
}

#[test]
fn an_asked_question_waits_in_needs_until_it_is_answered_and_show_returns_the_answer() {
    let home = Home::initialized();
    let (_plan, slice) = home.plan_and_slice();

    let asked = ask(&home, Some("manager"), &slice, "Which crate?");

    let item = asked["item"].as_str().expect("ask returns the item ID");
    assert_eq!(item.len(), 4, "{asked}");
    assert_eq!(asked["id"], json!(slice));
    assert_eq!(asked["text"], json!("Which crate?"));
    assert_eq!(
        needs_items(&home),
        [json!({ "reason": "question", "id": slice, "item": item, "text": "Which crate?" })]
    );

    let answer = home.tikk(&["answer", &slice, item, "--text", "serde-saphyr", "--json"]);

    assert_eq!(answer.exit_code, 0, "answer: {}", answer.stderr);
    assert_eq!(needs_items(&home), Vec::<Value>::new());
    let shown = home.tikk_with_environment(
        &home.work(),
        &[("TIKK_SESSION", Path::new("session-2"))],
        &["show", &slice, "--json"],
    );
    assert_eq!(shown.exit_code, 0, "show: {}", shown.stderr);
    let questions = &parse_json(&shown.stdout)["questions"];
    assert_eq!(questions[0]["item"], json!(item));
    assert_eq!(questions[0]["text"], json!("Which crate?"));
    assert_eq!(questions[0]["answer"]["text"], json!("serde-saphyr"));
    assert!(questions[0]["askedAt"].is_string(), "{questions}");
    assert!(
        questions[0]["answer"]["answeredAt"].is_string(),
        "{questions}"
    );
    assert_eq!(questions.as_array().map(Vec::len), Some(1));
}

#[test]
fn a_second_answer_replaces_the_first_in_show() {
    let home = Home::initialized();
    let (plan, _slice) = home.plan_and_slice();
    let item = ask(&home, None, &plan, "Which crate?")["item"]
        .as_str()
        .expect("an item")
        .to_owned();

    for text in ["serde-saphyr", "serde_yaml"] {
        let run = home.tikk(&["answer", &plan, &item, "--text", text]);

        assert_eq!(run.exit_code, 0, "answer {text}: {}", run.stderr);
    }

    let questions = &home.show_json(&plan)["questions"];
    assert_eq!(questions[0]["answer"]["text"], json!("serde_yaml"));
    assert_eq!(questions.as_array().map(Vec::len), Some(1));
}

#[test]
fn answer_to_an_unknown_item_exits_with_1_names_the_item_and_writes_nothing() {
    let home = Home::initialized();
    let (_plan, slice) = home.plan_and_slice();
    ask(&home, None, &slice, "Which crate?");
    let before = home.fact_lines();

    let run = home.tikk(&["answer", &slice, "zzzz", "--text", "yes", "--json"]);

    assert_eq!(run.exit_code, 1, "{}", run.stderr);
    let error = &parse_json(&run.stderr)["error"];
    assert_eq!(error["code"], json!("unknownQuestion"));
    assert!(
        error["message"]
            .as_str()
            .is_some_and(|message| message.contains("zzzz")),
        "{error}"
    );
    assert_eq!(home.fact_lines(), before);
}

#[test]
fn ask_with_blank_text_exits_with_2() {
    let home = Home::initialized();
    let (_plan, slice) = home.plan_and_slice();

    for text in ["", "  "] {
        let run = home.tikk(&["ask", &slice, "--text", text, "--json"]);

        assert_eq!(run.exit_code, 2, "case {text:?}: {}", run.stderr);
    }

    assert_eq!(home.fact_lines(), Vec::<Value>::new());
}

#[test]
fn ask_on_a_missing_ticket_exits_with_1_and_not_found() {
    let home = Home::initialized();

    let run = home.tikk(&["ask", "personal-abcd", "--text", "Which crate?", "--json"]);

    assert_eq!(run.exit_code, 1);
    assert_eq!(parse_json(&run.stderr)["error"]["code"], json!("notFound"));
}

#[test]
fn ask_by_another_agent_on_a_claimed_slice_exits_with_claimed_and_writes_nothing() {
    let home = Home::initialized();
    let (_plan, slice) = home.plan_and_slice();
    claim_live(&home, &slice, "manager");
    let before = home.fact_lines();

    let run = home.tikk_as(
        "other",
        &["ask", &slice, "--text", "Which crate?", "--json"],
    );

    assert_eq!(run.exit_code, 1, "{}", run.stderr);
    assert_eq!(parse_json(&run.stderr)["error"]["code"], json!("claimed"));
    assert_eq!(home.fact_lines(), before);
}

#[test]
fn ask_on_an_instruction_of_another_agents_slice_exits_with_claimed() {
    let home = Home::initialized();
    let (_plan, slice) = home.plan_and_slice();
    let instruction = home.new_ticket(&["instruction", "Write the parser", "--parent", &slice]);
    claim_live(&home, &slice, "manager");
    let before = home.fact_lines();

    let run = home.tikk_as(
        "other",
        &["ask", &instruction, "--text", "Which crate?", "--json"],
    );

    assert_eq!(run.exit_code, 1, "{}", run.stderr);
    assert_eq!(parse_json(&run.stderr)["error"]["code"], json!("claimed"));
    assert_eq!(home.fact_lines(), before);
}

#[test]
fn ask_by_the_holder_renews_the_lease_and_a_person_is_never_refused() {
    let home = Home::initialized();
    let (_plan, slice) = home.plan_and_slice();
    let claimed_end = claim_live(&home, &slice, "manager")["leaseEnd"].clone();
    std::thread::sleep(std::time::Duration::from_millis(5));

    ask(&home, Some("manager"), &slice, "Which crate?");
    ask(&home, None, &slice, "Which license?");

    let facts = home.fact_lines();
    let kinds: Vec<&Value> = facts.iter().map(|fact| &fact["kind"]).collect();
    assert_eq!(
        kinds,
        [
            &json!("claim"),
            &json!("question"),
            &json!("claim"),
            &json!("question")
        ]
    );
    let renewed_end = &home.show_json(&slice)["claim"]["leaseEnd"];
    assert!(
        renewed_end.as_str() > claimed_end.as_str(),
        "{renewed_end} after {claimed_end}"
    );
}

mod support;

use std::time::Instant;

use serde_json::json;

use support::{Home, numbered_id, parse_json};

fn write_bench_tickets(home: &Home) -> Vec<String> {
    let folder = home.store().join("tickets/personal");
    std::fs::create_dir_all(&folder).expect("create the project folder");
    let mut slices = Vec::new();

    for index in 0..2_000 {
        let id = numbered_id(index);
        let plan = numbered_id(index / 100 * 100);
        let text = if index % 100 == 0 {
            format!("---\nkind: plan\ntitle: Plan {index}\nstatus: open\n---\nThe design.\n")
        } else {
            let blocked_by = if index % 100 == 1 {
                String::new()
            } else {
                numbered_id(index - 1)
            };

            slices.push(id.clone());
            format!(
                "---\nkind: slice\ntitle: Slice {index}\nstatus: open\nparent: {plan}\nblockedBy: [{blocked_by}]\ncriteria:\n  - id: s1\n    check: cargo nextest run\n    expected: The tests pass.\n---\nThe body of slice {index}.\n"
            )
        };

        std::fs::write(folder.join(format!("{id}-ticket-{index}.md")), text)
            .expect("write a ticket");
    }

    slices
}

fn write_bench_facts(home: &Home, slices: &[String]) {
    let folder = home.store().join("facts/test");
    std::fs::create_dir_all(&folder).expect("create the machine folder");
    let mut text = String::new();

    for index in 0..100_000 {
        let ticket = &slices[index % slices.len()];
        let at = format!(
            "2026-01-{:02}T{:02}:{:02}:{:02}Z",
            1 + index / 86_400,
            index % 86_400 / 3_600,
            index % 3_600 / 60,
            index % 60
        );

        let line = if index % 2 == 0 {
            format!(
                "{{\"v\":1,\"kind\":\"claim\",\"ticket\":\"{ticket}\",\"at\":\"{at}\",\"agent\":\"manager-{index}\",\"session\":\"session-{index}\",\"sessionLog\":null,\"leaseEnd\":\"2026-01-05T00:00:00Z\"}}\n"
            )
        } else {
            format!(
                "{{\"v\":1,\"kind\":\"release\",\"ticket\":\"{ticket}\",\"at\":\"{at}\",\"agent\":null}}\n"
            )
        };

        text.push_str(&line);
    }

    std::fs::write(folder.join("2026-01.jsonl"), text).expect("write the fact file");
}

#[test]
#[expect(
    clippy::print_stderr,
    reason = "the test reports the measured time for the slice record"
)]
fn ready_json_of_two_thousand_tickets_and_a_hundred_thousand_facts_reports_its_time() {
    let home = Home::initialized();
    let slices = write_bench_tickets(&home);
    write_bench_facts(&home, &slices);

    let started = Instant::now();
    let run = home.tikk(&["ready", "--json"]);
    let elapsed = started.elapsed();

    assert_eq!(run.exit_code, 0, "stderr: {}", run.stderr);
    let queue = parse_json(&run.stdout);
    assert_eq!(queue["candidates"].as_array().map(Vec::len), Some(20));
    assert_eq!(queue["skipped"].as_array().map(Vec::len), Some(1_960));
    assert_eq!(queue["errors"], json!([]));
    eprintln!(
        "tikk ready --json with 2,000 tickets and 100,000 fact lines took {} ms",
        elapsed.as_millis()
    );
}

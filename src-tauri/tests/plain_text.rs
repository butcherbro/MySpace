//! Pins the Rust plain-text codec (`domain::plain_text`) against the shared
//! fixtures in `tests/fixtures/plain_text_cases.json`, whose expected values
//! come from the TypeScript `documentToPlainText` (P1.5). If this fails after
//! a codec change, update both codecs and the fixture file together.

use myspace_lib::domain::plain_text::{document_to_plain_text, plain_text_to_document};
use serde_json::Value;

fn cases() -> Vec<(String, Value, String)> {
    let raw = include_str!("fixtures/plain_text_cases.json");
    let parsed: Vec<Value> = serde_json::from_str(raw).expect("fixture is a JSON array");
    parsed
        .into_iter()
        .map(|case| {
            let name = case["name"].as_str().expect("name").to_string();
            let expected = case["expected"].as_str().expect("expected").to_string();
            (name, case["doc"].clone(), expected)
        })
        .collect()
}

#[test]
fn codec_matches_every_shared_fixture() {
    let cases = cases();
    assert!(cases.len() >= 8, "fixture file lost cases");
    let failures: Vec<String> = cases
        .iter()
        .filter_map(|(name, doc, expected)| {
            let actual = document_to_plain_text(doc);
            (actual != *expected).then(|| format!("{name}: expected {expected:?}, got {actual:?}"))
        })
        .collect();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn fixtures_include_the_typescript_unit_cases() {
    let ts_cases = cases()
        .iter()
        .filter(|(name, _, _)| name.starts_with("ts: "))
        .count();
    assert_eq!(
        ts_cases, 9,
        "every documentToPlainText unit case is mirrored"
    );
}

#[test]
fn plain_text_to_document_round_trips() {
    for text in ["", "hello", "мой комментарий", "a  b"] {
        assert_eq!(document_to_plain_text(&plain_text_to_document(text)), text);
    }
}

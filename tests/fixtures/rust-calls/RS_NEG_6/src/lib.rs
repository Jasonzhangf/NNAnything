mod mod_a;
mod mod_b;

use crate::mod_a::*;
use crate::mod_b::*;

pub fn run_glob_and_ext(raw: &str) -> usize {
    let _ = serde_json::from_str::<serde_json::Value>(raw);
    parse_item(raw)
}

mod policy;
mod backoff;

use crate::policy::{evaluate_retry as eval_policy};

pub fn run_entry(attempts: u32) -> bool {
    let ok = eval_policy(attempts);
    if !ok {
        backoff::wait_tick();
    }
    ok
}

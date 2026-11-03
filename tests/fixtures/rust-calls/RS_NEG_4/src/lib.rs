pub fn fast_leaf() -> u32 { 1 }
pub fn slow_leaf() -> u32 { 2 }

#[cfg(feature = "fast")]
pub fn compute() -> u32 {
    fast_leaf()
}

#[cfg(not(feature = "fast"))]
pub fn compute() -> u32 {
    slow_leaf()
}

pub fn run_compute() -> u32 {
    compute()
}

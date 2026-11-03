pub fn hook(v: i32) -> i32 {
    v * 10
}

pub fn run_with_hook(hook: fn(i32) -> i32, v: i32) -> i32 {
    let local_cb = |a: i32| a + 1;
    let step = local_cb(v);
    hook(step)
}

macro_rules! dispatch_call {
    ($fn_name:ident) => {
        $fn_name()
    };
}

pub fn real_helper() -> i32 {
    42
}

pub fn handle_event(x: Option<i32>) -> i32 {
    if matches!(x, Some(1)) {
        return dispatch_call!(real_helper);
    }
    0
}

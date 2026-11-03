pub fn evaluate_retry(attempts: u32) -> bool {
    if attempts == 0 {
        return false;
    }
    if attempts > 1 {
        return evaluate_retry(attempts - 1);
    }
    true
}

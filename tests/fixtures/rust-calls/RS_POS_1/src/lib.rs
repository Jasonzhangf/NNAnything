// Comment mentioning entry_dispatch should be classified as non_code
pub struct Worker {
    pub limit: usize,
}

impl Worker {
    pub fn new(limit: usize) -> Self {
        Self { limit }
    }

    pub fn execute(&self) -> usize {
        Self::compute_step(self.limit)
    }

    fn compute_step(v: usize) -> usize {
        v + 1
    }
}

pub fn validate_limit(limit: usize) -> bool {
    limit > 0
}

pub fn entry_dispatch(limit: usize) -> usize {
    if !validate_limit(limit) {
        return 0;
    }
    let worker = Worker::new(limit);
    worker.execute()
}

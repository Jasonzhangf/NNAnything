fn outer() {
    fn inner() {}
    inner();
}

fn holder() {
    struct LocalS;
    impl LocalS {
        fn m(&self) {}
    }
}

fn first() {
    fn dup() {}
}

fn second() {
    fn dup() {}
}

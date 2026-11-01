fn outer() {
    fn dup() {}
    {
        fn dup() {}
        dup();
    }
    if true {
        fn dup() {}
        dup();
    }
}

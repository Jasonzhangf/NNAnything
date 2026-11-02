fn outer() {
    fn direct() {}
    {
        fn nested() {}
        nested();
    }
    if true {
        fn conditional() {}
        conditional();
    }
}

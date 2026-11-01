fn branches() {
    if true {
        fn if_branch() {}
    } else {
        fn if_else() {}
    }
    loop {
        fn loop_branch() {}
        break;
    }
    while false {
        fn while_branch() {}
    }
    for _ in 0..1 {
        fn for_branch() {}
    }
    match true {
        _ => {
            fn match_branch() {}
        }
    }
    {
        {
            fn deep_branch() {}
        }
    }
    if true {
        fn repeated() {}
    } else {
        fn repeated() {}
    }
    if true {
        struct BranchLocal;
        impl BranchLocal {
            fn branch_method(&self) {}
        }
    }
}

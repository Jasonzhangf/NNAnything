macro_rules! declare_widget {
    ($name:ident) => {
        pub struct $name;
    };
}

declare_widget!(GeneratedWidget);

pub fn real_function() {}

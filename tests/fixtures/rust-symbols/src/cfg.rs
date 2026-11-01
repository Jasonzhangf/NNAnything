#[cfg(test)]
mod test_support {
    pub fn seed() {}
}

#[cfg(feature = "extra")]
#[cfg_attr(debug_assertions, allow(dead_code))]
pub struct OptionalThing;

pub fn always_here() {}

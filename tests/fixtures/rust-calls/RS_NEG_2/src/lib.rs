pub trait Verifier {
    fn check(&self) -> bool;
}

pub struct Node;

impl Node {
    pub fn check(&self) -> bool { true }
}

impl Verifier for Node {
    fn check(&self) -> bool { false }
}

pub fn make_node() -> Node {
    Node
}

pub fn run_untyped_and_colliding(node: &Node) -> bool {
    let item = make_node();
    let a = item.check();
    let b = node.check();
    a && b
}

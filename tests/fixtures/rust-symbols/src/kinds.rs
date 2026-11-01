pub struct Widget {
    pub id: u32,
}

pub enum Mode {
    On,
    Off,
}

pub trait Renderer {
    fn render(&self) -> String;
}

pub mod geometry {
    pub fn area() -> u32 {
        0
    }
}

pub struct Canvas;

impl Canvas {
    pub fn draw(&self) {}
}

impl Renderer for Canvas {
    fn render(&self) -> String {
        String::new()
    }
}

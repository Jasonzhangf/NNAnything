pub trait PolicyReader {
    fn read_slot(&self) -> u32;
}

pub struct ImplA;
impl PolicyReader for ImplA {
    fn read_slot(&self) -> u32 { 1 }
}

pub struct ImplB;
impl PolicyReader for ImplB {
    fn read_slot(&self) -> u32 { 2 }
}

pub fn select_slot<R: PolicyReader>(reader: &R, dyn_reader: &dyn PolicyReader) -> u32 {
    reader.read_slot() + dyn_reader.read_slot()
}

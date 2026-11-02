package fixture.records;

record Rec(int x, String y) {
    public Rec {
        if (x < 0) throw new IllegalArgumentException();
    }
    static int z = 1;
    int total() { return x + z; }
}

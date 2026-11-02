package fixture.enums;

enum E {
    @Deprecated FIRST(1),
    SECOND(2);
    int FIRST = 2;
    E() {}
    E(int v) {}
    int rank() { return FIRST; }
}

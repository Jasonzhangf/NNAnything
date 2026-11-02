package fixture.nested;

class Alpha {
    void shared() {}
    void shared(int x) {}
    class Inner {
        void shared() {}
    }
}

class Beta {
    void shared() {}
    void shared(String s) {}
}

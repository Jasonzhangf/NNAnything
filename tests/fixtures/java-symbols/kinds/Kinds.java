package fixture.kinds;

import java.io.File;

public class Kinds {
    public Kinds() {}
    private static final int MAGIC = 7;
    public String field;
    public void visible() {}
    protected void guarded() {}
    private void hidden() {}
    void packagePrivate() {}
    static class Nested {}
    interface Inner {
        default void d() {}
    }
    enum Mode {
        FAST,
        SLOW;
        int code;
    }
    @interface Marker {}
    public Runnable make() {
        return new Runnable() {
            @Override public void run() {}
        };
    }
}

interface Api {
    void load();
}

record Point(int x, int y) {}

@interface Ann {
    String value();
}

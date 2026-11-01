package fixture.scopes

class OwnerA {
    fun same() {}
}

class OwnerB {
    fun same() {}
}

class LocalHost {
    fun outer() {
        fun same() {}
        same()
    }
}

fun topLevel() {}

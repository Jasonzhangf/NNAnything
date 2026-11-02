package fixture.local_scopes

class C {
    init { fun initLocal() {} }
    val p = run { fun lambdaLocal() {}; 1 }
    constructor(x: Int) { fun constructorLocal() {} }
    fun outer() { fun inner() {} }
    fun owner() { class Inner { fun localMember() {} } }
}

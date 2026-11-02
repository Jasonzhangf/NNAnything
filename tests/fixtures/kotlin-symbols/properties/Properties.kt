package fixture.properties

class ConstructorProperties(
    private val privateValue: String,
    var mutableValue: Int,
) {
    val bodyValue: String = privateValue
    private val hidden: Int = mutableValue
}

val String.extensionLength: Int
    get() = length

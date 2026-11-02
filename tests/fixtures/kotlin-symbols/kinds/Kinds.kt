package fixture.kinds

object Registry {
    fun value(): Int = 1
}

class Host {
    companion object {
        fun companionValue(): Int = 2
    }
}

interface Api {
    fun load(): String
}

data class Payload(val value: String)

enum class Mode {
    FAST,
    SLOW;

    fun label(): String = name
}

typealias StringList = List<String>

fun String.bang(): String = this + "!"

val String.sizeOrZero: Int
    get() = length

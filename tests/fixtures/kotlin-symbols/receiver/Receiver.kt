package fixture.receiver

class Factory {
    fun run(): Int = 1
}

fun factory(): Factory = Factory()

fun complexReceiver() {
    factory().run()
}

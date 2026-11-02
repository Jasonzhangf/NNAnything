public struct _InternalBox {
  public var _cache: Int = 0
  public let a = 1, b = 2
  public let (x, y) = (10, 20)
  public func _helper(_ v: Int) -> Int { v }
  public func `default`() {}
  public func 計算(値: Int) -> Int { 値 }
  public static func == (lhs: _InternalBox, rhs: _InternalBox) -> Bool { true }
}

public final class MyFinalClass {
  public class var sharedCount: Int { 0 }
  public class func makeInstance() -> MyFinalClass { MyFinalClass() }
  public func /* 😀 */ afterInlineEmoji() {}
  init?() {}
  deinit {}
  subscript(index: Int) -> Int { index }
}

public actor Counter {
  private var count: Int = 0
  public func increment() { count += 1 }
}

public protocol Greetable {
  func greet(name: String) -> String
}

public extension Greetable {
  func greet(name: String) -> String { "hi \(name)" }
}

public enum Result<T> {
  case success(T)
  case failure(code: Int)
  case plain
  public var value: T? { nil }
}

public enum Other {
  case plain
}

public typealias Callback = (Int) -> Void

public func overload(_ value: Int) {}
public func overload(value: String) {}
public func topLevel() {}
private func _topHidden() {}

@main
public struct AppMain {
  public static func main() {}
}


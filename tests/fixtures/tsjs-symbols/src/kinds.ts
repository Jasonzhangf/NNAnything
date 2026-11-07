export interface I { x: number; m(a: number): string; }
export type T = number;
export enum E { A, B = 2 }
export namespace N {
  export const v = 1;
  export function f() {}
}
export abstract class C {
  public readonly id: string;
  #secret: number;
  static s = 1;
  constructor(public readonly name: string) {}
  get g() { return 1; }
  set w(x: number) {}
  override m(): void {}
  [Symbol.iterator]() {}
  [dynProp] = 1;
}
export const arrowFn = () => {};
export const { a, b: [c] } = obj;
export default function namedDefault() {}
function outer() {
  const tmp = 1;
  function localHelper() {}
}

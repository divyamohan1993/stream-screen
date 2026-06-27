/**
 * Minimal ambient type shim for the OPTIONAL native input library
 * `@nut-tree-fork/nut-js`.
 *
 * The real package ships native bindings that only build/run on the target
 * (Windows) machine, so we deliberately keep it as an `optionalDependencies`
 * entry and load it via dynamic `import()` at runtime. This shim exists purely
 * so the host package type-checks on Linux (and in CI) WITHOUT the native
 * library being installed.
 *
 * Only the subset of the API that {@link input-injector} actually calls is
 * declared here. Keep it in sync with src/input-injector.ts.
 */
declare module '@nut-tree-fork/nut-js' {
  /** A screen-space point in physical pixels. */
  export interface Point {
    x: number;
    y: number;
  }

  /** Mouse buttons, as exposed by nut.js. */
  export enum Button {
    LEFT = 0,
    MIDDLE = 1,
    RIGHT = 2,
  }

  /**
   * Keyboard keys. nut.js exposes a large enum; we type it loosely as a string
   * index so any key name resolves. Runtime values are the real enum members.
   */
  export const Key: Record<string, number>;
  export type Key = number;

  /** Mouse control surface. */
  export interface MouseClass {
    setPosition(target: Point): Promise<MouseClass>;
    getPosition(): Promise<Point>;
    pressButton(btn: Button): Promise<MouseClass>;
    releaseButton(btn: Button): Promise<MouseClass>;
    scrollUp(amount: number): Promise<MouseClass>;
    scrollDown(amount: number): Promise<MouseClass>;
    scrollLeft(amount: number): Promise<MouseClass>;
    scrollRight(amount: number): Promise<MouseClass>;
    config: { autoDelayMs: number; mouseSpeed: number };
  }

  /** Keyboard control surface. */
  export interface KeyboardClass {
    pressKey(...keys: Key[]): Promise<KeyboardClass>;
    releaseKey(...keys: Key[]): Promise<KeyboardClass>;
    type(input: string): Promise<KeyboardClass>;
    config: { autoDelayMs: number };
  }

  /** Screen control surface (used for resolution lookups). */
  export interface ScreenClass {
    width(): Promise<number>;
    height(): Promise<number>;
  }

  export const mouse: MouseClass;
  export const keyboard: KeyboardClass;
  export const screen: ScreenClass;
  export function straightTo(target: Point | Promise<Point>): Promise<Point[]>;
}

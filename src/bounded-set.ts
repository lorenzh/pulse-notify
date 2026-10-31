/**
 * A set with at most `max` keys. At capacity, a new key evicts the oldest inserted one.
 * Adding a key that is already held does not refresh it.
 */
export class BoundedSet {
  readonly #max: number;
  readonly #keys = new Set<string>();

  constructor(max: number) {
    this.#max = max;
  }

  /** True when the key was new. */
  add(key: string): boolean {
    if (this.#keys.has(key)) return false;
    if (this.#keys.size >= this.#max) {
      // A Set iterates in insertion order, so the first key is the oldest.
      for (const oldest of this.#keys) {
        this.#keys.delete(oldest);
        break;
      }
    }
    this.#keys.add(key);
    return true;
  }

  has(key: string): boolean {
    return this.#keys.has(key);
  }

  get size(): number {
    return this.#keys.size;
  }
}

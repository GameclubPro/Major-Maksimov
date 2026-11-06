const MAX_ENTRIES = 256;
const TTL_MS = 5 * 60_000;

// FLAG: This memo stores only cloned native metadata. It never retains image bytes,
// URLs, message identity, settings, source availability or authorization decisions.
export class PhotoNativeResultMemo<T> {
  private readonly entries = new Map<string, { expiresAtMs: number; value: T }>();

  constructor(private readonly clone: (value: T) => T) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAtMs <= Date.now()) return undefined;
    this.entries.set(key, entry);
    return this.clone(entry.value);
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, { expiresAtMs: Date.now() + TTL_MS, value: this.clone(value) });
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}

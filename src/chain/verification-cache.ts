export const VERIFICATION_TTL_MS = 120_000;

/** A point-in-time, read-only release check. Never authorizes a transaction. */
export type ReadOnlyVerification<T> = {
  value: T;
  checkedAt: number;
  startedAt: number;
  expiresAt: number;
};

export function verificationIsFresh<T>(entry: ReadOnlyVerification<T>, now = performance.now()): boolean {
  return now >= entry.startedAt && now < entry.expiresAt;
}

/** Two RAM-only network slots, keyed by the entire parsed manifest, with one load in flight per key. */
export function createVerificationCache<T>(clock = () => performance.now(), wallClock = () => Date.now()) {
  type Slot = { key: string; cached?: ReadOnlyVerification<T>; pending?: Promise<ReadOnlyVerification<T>> };
  const slots = new Map<number, Slot>();
  return {
    invalidate(network: number) {
      const slot = slots.get(network);
      if (slot) slot.cached = undefined; // A refresh must not duplicate an in-flight verification.
    },
    async read(network: number, exactManifest: string, load: () => Promise<T>): Promise<ReadOnlyVerification<T>> {
      if (network !== 26514 && network !== 2651420) throw new Error("Unsupported verification network.");
      let slot = slots.get(network);
      if (!slot || slot.key !== exactManifest) {
        slot = { key: exactManifest };
        slots.set(network, slot);
      }
      if (slot.cached && verificationIsFresh(slot.cached, clock())) return slot.cached;
      if (slot.pending) return slot.pending;
      const target = slot;
      target.cached = undefined;
      const startedAt = clock();
      target.pending = Promise.resolve().then(load).then((value) => {
        // TTL starts before network work: a slow verification never extends its own freshness.
        const result = { value, checkedAt: wallClock(), startedAt, expiresAt: startedAt + VERIFICATION_TTL_MS };
        if (!verificationIsFresh(result, clock())) throw new Error("Market checks expired. Please retry.");
        target.cached = result;
        return result;
      }).finally(() => { target.pending = undefined; });
      return target.pending;
    },
  };
}

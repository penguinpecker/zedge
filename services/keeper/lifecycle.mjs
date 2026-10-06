import { requireCondition } from './streams.mjs';

export function schedules(timestamp, lookBack = 4800) {
  requireCondition(Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp < 0xffffffff - 10000, 'KEEPER_CLOCK');
  const rounds = [];
  // A restarted keeper also reconciles its persisted active-round set, irrespective of this window.
  for (const duration of [300, 900]) for (const asset of [0, 1]) {
    const aligned = Math.floor(timestamp / duration) * duration;
    for (let start = aligned - Math.ceil(lookBack / duration) * duration; start <= aligned + 2 * duration; start += duration) {
      if (start > 0) rounds.push({ asset, duration, start });
    }
  }
  return rounds;
}

// Phases are the registry's own (0 Missing, 1 Scheduled, 2 OpeningPending, 3 Trading, 4 Closed, 5 ResolutionPending,
// 6 Resolved, 7 Voided, 8 Voidable), read at `now`. For a Voidable round, openedAt is the registry's too: 0 when
// nobody recorded its opening in time.
// unobtainable: the keeper gives up the closing price of an opened, Voidable round on this tick (main.mjs, step).
export function chooseAction(round, now, cachePresent, sourcePresent, unobtainable = false) {
  requireCondition(Number.isSafeInteger(now) && now > 0, 'KEEPER_CLOCK');
  const { phase, start, end, openingDeadline } = round;
  if (phase === 0) return start > now + 20 ? { kind: 'create', deadline: start - 1, boundary: start } : null;
  // A round nobody opened in time holds nothing to settle: void it as soon as the registry calls it Voidable.
  if (phase === 8 && round.openedAt === 0 || phase === 2 && now > openingDeadline) return { kind: 'void', deadline: Number.MAX_SAFE_INTEGER, boundary: start };
  if (phase !== 2 && phase !== 5 && phase !== 8) return null;
  const opening = phase === 2, boundary = opening ? start : end;
  if (now < boundary) return null;
  const deadline = opening ? openingDeadline ?? start : Number.MAX_SAFE_INTEGER;
  // Resolution has no deadline: an opened round is resolved whenever its closing price is cached, however late.
  if (cachePresent) return { kind: opening ? 'open' : 'resolve', deadline, boundary };
  // An opened round the registry calls Voidable has nothing cached 60 s + voidGrace (300 s in the profile) after its
  // end. It is still worked exactly like a round awaiting resolution (publish, relay, resolve) until the keeper gives it up.
  if (phase === 8 && unobtainable) return { kind: 'void', deadline, boundary };
  return { kind: sourcePresent ? 'await-delivery' : 'publish', deadline, boundary };
}

export function orderedActions(actions) {
  // Fix/resolve expiring boundaries before scheduling new rounds or processing old voids.
  const priority = kind => kind === 'void' ? 2 : kind === 'create' ? 1 : 0;
  return [...actions].sort((a, b) => priority(a.kind) - priority(b.kind)
    || a.deadline - b.deadline || a.boundary - b.boundary || String(a.roundId).localeCompare(String(b.roundId)));
}

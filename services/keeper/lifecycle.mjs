import { requireCondition } from './streams.mjs';

export function schedules(timestamp, lookAhead = 2) {
  requireCondition(Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp < 0xffffffff - 10000, 'KEEPER_CLOCK');
  requireCondition(Number.isSafeInteger(lookAhead) && lookAhead >= 1 && lookAhead <= 4, 'KEEPER_LOOKAHEAD');
  const rounds = [];
  // A restarted keeper also reconciles its persisted active-round set, irrespective of this window.
  for (const duration of [300, 900]) for (const asset of [0, 1]) {
    const aligned = Math.floor(timestamp / duration) * duration;
    for (let start = aligned - Math.ceil(4800 / duration) * duration; start <= aligned + lookAhead * duration; start += duration) {
      if (start > 0) rounds.push({ asset, duration, start });
    }
  }
  return rounds;
}

export function chooseAction(round, now, cachePresent, sourcePresent) {
  requireCondition(Number.isSafeInteger(now) && now > 0, 'KEEPER_CLOCK');
  if (!round) return null;
  const { phase, start, end, openingDeadline, resolutionDeadline, openedAt } = round;
  if (phase === 0) return start > now + 20 ? { kind: 'create', deadline: start - 1, boundary: start } : null;
  if (phase === 6 || phase === 7 || now < start) return null;
  const opening = openedAt === 0;
  const deadline = opening ? openingDeadline : resolutionDeadline;
  const boundary = opening ? start : end;
  if (now > deadline) return { kind: 'void', deadline: Number.MAX_SAFE_INTEGER, boundary };
  if (now < boundary) return null;
  if (cachePresent) return { kind: opening ? 'open' : 'resolve', deadline, boundary };
  return { kind: sourcePresent ? 'await-delivery' : 'publish', deadline, boundary };
}

export function orderedActions(actions) {
  // Fix/resolve expiring boundaries before scheduling new rounds or processing old voids.
  const priority = kind => kind === 'void' ? 2 : kind === 'create' ? 1 : 0;
  return [...actions].sort((a, b) => priority(a.kind) - priority(b.kind)
    || a.deadline - b.deadline || a.boundary - b.boundary || String(a.roundId).localeCompare(String(b.roundId)));
}

/**
 * Smart Match — deterministic provider ranking.
 *
 * When several staff can deliver a service at the same time, something has to
 * choose. This is that something, and it is deliberately *not* AI: the ranking
 * is a weighted sum of observable facts, every contribution is recorded, and
 * the same inputs always produce the same order. A business owner can be told
 * exactly why Priya was offered instead of Sam.
 *
 * If an AI-assisted strategy is ever added it belongs behind this same
 * interface, and booking correctness must never depend on it.
 */

/** Everything the ranker is allowed to consider about one candidate. */
export interface StaffCandidate {
  staffProfileId: string;
  displayName: string;
  /** Explicit ordering from service_staff / team_members. Lower wins. */
  priority: number;
  /** Relative share of round-robin assignments. Higher gets more work. */
  weight: number;
  /** Appointments already booked in the window being scheduled. */
  currentLoad: number;
  /** Cap from the staff profile, when one is configured. */
  maxDailyAppointments: number | null;
  /** When this member was last given an appointment (round-robin fairness). */
  lastAssignedAt: Date | null;
  /** True when the customer has seen this provider before. */
  isPreviousProvider: boolean;
  /** True when the customer explicitly nominated this provider. */
  isPreferredProvider: boolean;
  /** True when the member is assigned to the requested location. */
  servesRequestedLocation: boolean;
}

export type AssignmentStrategy = 'ROUND_ROBIN' | 'COLLECTIVE' | 'POOLED' | 'SMART_MATCH';

/**
 * Factor weights.
 *
 * Ordered by how strongly a business would defend the choice: an explicit
 * customer preference outranks continuity, which outranks fair distribution,
 * which outranks tie-breaking configuration.
 */
export const SMART_MATCH_WEIGHTS = {
  preferredProvider: 100,
  previousProvider: 45,
  locationMatch: 30,
  workloadBalance: 25,
  roundRobinFairness: 20,
  configuredPriority: 15,
} as const;

export interface RankedStaff {
  candidate: StaffCandidate;
  score: number;
  /** Per-factor contributions, in the response so a ranking is explainable. */
  factors: Array<{
    factor: keyof typeof SMART_MATCH_WEIGHTS | 'weight';
    points: number;
    reason: string;
  }>;
}

/** Normalises "lower is better" priority into 0..1 where 1 is best. */
function priorityScore(priority: number, allPriorities: number[]): number {
  const min = Math.min(...allPriorities);
  const max = Math.max(...allPriorities);
  if (max === min) return 1;
  return 1 - (priority - min) / (max - min);
}

/** Normalises current load into 0..1 where 1 is the least busy candidate. */
function workloadScore(candidate: StaffCandidate, allLoads: number[]): number {
  const max = Math.max(...allLoads);
  if (max === 0) return 1;
  const relief = 1 - candidate.currentLoad / max;

  // A member near their configured daily cap is pushed down further, so the
  // last few slots of the day spread out instead of piling onto one person.
  if (candidate.maxDailyAppointments && candidate.maxDailyAppointments > 0) {
    const utilisation = candidate.currentLoad / candidate.maxDailyAppointments;
    return relief * Math.max(0, 1 - utilisation);
  }
  return relief;
}

/**
 * Round-robin fairness: the longer since a member was last assigned, the higher
 * they score. `weight` scales the effect, so a 2× weighted member becomes
 * eligible again roughly twice as quickly.
 */
function fairnessScore(candidate: StaffCandidate, now: Date): number {
  if (!candidate.lastAssignedAt) return 1; // never assigned — go first
  const hoursSince = (now.getTime() - candidate.lastAssignedAt.getTime()) / 3_600_000;
  const normalised = Math.min(1, hoursSince / 168); // saturates after one week
  return Math.min(1, normalised * Math.max(1, candidate.weight));
}

/**
 * Ranks candidates best-first.
 *
 * Ties are broken by staffProfileId so the order is stable across processes —
 * two API instances answering the same availability query must agree.
 */
export function rankCandidates(
  candidates: StaffCandidate[],
  options: { now: Date; strategy?: AssignmentStrategy } = { now: new Date() },
): RankedStaff[] {
  if (candidates.length === 0) return [];

  const strategy = options.strategy ?? 'SMART_MATCH';
  const priorities = candidates.map((candidate) => candidate.priority);
  const loads = candidates.map((candidate) => candidate.currentLoad);

  const ranked = candidates.map<RankedStaff>((candidate) => {
    const factors: RankedStaff['factors'] = [];
    let score = 0;

    const add = (
      factor: keyof typeof SMART_MATCH_WEIGHTS,
      normalised: number,
      reason: string,
    ): void => {
      const points = Math.round(SMART_MATCH_WEIGHTS[factor] * normalised * 100) / 100;
      if (points !== 0) factors.push({ factor, points, reason });
      score += points;
    };

    if (candidate.isPreferredProvider) {
      add('preferredProvider', 1, 'The customer nominated this provider.');
    }
    if (candidate.isPreviousProvider) {
      add('previousProvider', 1, 'The customer has been seen by this provider before.');
    }
    if (candidate.servesRequestedLocation) {
      add('locationMatch', 1, 'Assigned to the requested location.');
    }

    // ROUND_ROBIN deliberately ignores workload and preference: its whole
    // purpose is even distribution by turn, and mixing in other factors would
    // make it something other than round robin.
    if (strategy === 'ROUND_ROBIN') {
      add(
        'roundRobinFairness',
        fairnessScore(candidate, options.now),
        'Longest since last assigned.',
      );
    } else {
      add('workloadBalance', workloadScore(candidate, loads), 'Lighter current workload.');
      add('roundRobinFairness', fairnessScore(candidate, options.now) * 0.5, 'Fair rotation.');
      add(
        'configuredPriority',
        priorityScore(candidate.priority, priorities),
        'Configured priority.',
      );
    }

    return { candidate, score: Math.round(score * 100) / 100, factors };
  });

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.candidate.priority !== b.candidate.priority) {
      return a.candidate.priority - b.candidate.priority;
    }
    return a.candidate.staffProfileId.localeCompare(b.candidate.staffProfileId);
  });

  return ranked;
}

/** The winning candidate, or null when there are none. */
export function selectBestCandidate(
  candidates: StaffCandidate[],
  options: { now: Date; strategy?: AssignmentStrategy },
): RankedStaff | null {
  return rankCandidates(candidates, options)[0] ?? null;
}

/** Compact, human-readable explanation for the API's `explain` mode. */
export function explainRanking(ranked: RankedStaff): string {
  if (ranked.factors.length === 0)
    return `${ranked.candidate.displayName}: no differentiating factors.`;
  const parts = ranked.factors
    .slice()
    .sort((a, b) => b.points - a.points)
    .map((factor) => `${factor.reason} (+${factor.points})`);
  return `${ranked.candidate.displayName} scored ${ranked.score}: ${parts.join(' ')}`;
}

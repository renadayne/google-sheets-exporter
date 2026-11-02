/**
 * T30a Bounded Pure Job Phase Transitions
 *
 * Implements pure job phase types, terminal predicates, transition validity,
 * and transition assertion guards.
 *
 * Invariants & Guarantees:
 * 1. Architecture sequence:
 *    idle -> authenticating -> checking_permission -> discovering -> ready ->
 *    planning -> reading -> serializing -> final_check -> downloading -> completed.
 * 2. Self-transitions are permitted only for recognized phases (idempotent progress/state updates).
 * 3. Active phases (all except idle and terminals) allow terminal branches:
 *    restricted, uncertain, failed, cancelled, interrupted.
 * 4. Completed is reachable ONLY from downloading (or completed self-transition).
 * 5. Idle cannot claim terminal results.
 * 6. Terminal phases cannot reactivate or transition to any other phase.
 * 7. Malformed / unknown phases or prototype keys:
 *    - isTerminalJobPhase: false
 *    - canTransitionJobPhase: false
 *    - assertJobTransition: throws new static DomainError('INTERNAL_ERROR')
 * 8. Pure functions only: no side effects, no timers, no network, no mutations.
 */

import { DomainError } from '../contracts/errors.ts';

export type JobPhase =
  | 'idle'
  | 'authenticating'
  | 'checking_permission'
  | 'discovering'
  | 'ready'
  | 'planning'
  | 'reading'
  | 'serializing'
  | 'final_check'
  | 'downloading'
  | 'completed'
  | 'restricted'
  | 'uncertain'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/** Recognized terminal phases. */
const TERMINAL_PHASES: ReadonlySet<JobPhase> = new Set<JobPhase>([
  'completed',
  'restricted',
  'uncertain',
  'failed',
  'cancelled',
  'interrupted',
]);

/** Recognized active phases (all recognized phases except idle and terminals). */
const ACTIVE_PHASES: ReadonlySet<JobPhase> = new Set<JobPhase>([
  'authenticating',
  'checking_permission',
  'discovering',
  'ready',
  'planning',
  'reading',
  'serializing',
  'final_check',
  'downloading',
]);

/** All 16 recognized JobPhase values. */
const ALL_PHASES: ReadonlySet<JobPhase> = new Set<JobPhase>([
  'idle',
  'authenticating',
  'checking_permission',
  'discovering',
  'ready',
  'planning',
  'reading',
  'serializing',
  'final_check',
  'downloading',
  'completed',
  'restricted',
  'uncertain',
  'failed',
  'cancelled',
  'interrupted',
]);

/** Terminal abortive phases reachable from any active phase. */
const ABORTIVE_TERMINAL_PHASES: ReadonlySet<JobPhase> = new Set<JobPhase>([
  'restricted',
  'uncertain',
  'failed',
  'cancelled',
  'interrupted',
]);

/** Normal legal forward progression map. */
const NEXT_SEQUENTIAL_PHASE: ReadonlyMap<JobPhase, JobPhase> = new Map<JobPhase, JobPhase>([
  ['idle', 'authenticating'],
  ['authenticating', 'checking_permission'],
  ['checking_permission', 'discovering'],
  ['discovering', 'ready'],
  ['ready', 'planning'],
  ['planning', 'reading'],
  ['reading', 'serializing'],
  ['serializing', 'final_check'],
  ['final_check', 'downloading'],
  ['downloading', 'completed'],
]);

/**
 * Returns true if the given phase is a recognized terminal phase.
 * Returns false for unknown, non-string, or malformed inputs without invoking getters.
 */
export function isTerminalJobPhase(phase: JobPhase): boolean {
  if (typeof phase !== 'string') {
    return false;
  }
  return TERMINAL_PHASES.has(phase as JobPhase);
}

/**
 * Evaluates whether a transition from `from` to `to` is legally permitted.
 *
 * Invariants:
 * - Both phases must be recognized JobPhase strings.
 * - Self-transitions are permitted for any recognized phase (idempotent progress).
 * - Terminal phases cannot transition to any different phase (no reactivation or reset).
 * - 'idle' can only transition to 'authenticating' (or idle self-transition).
 * - Active phases can advance sequentially, or branch to restricted/uncertain/failed/cancelled/interrupted.
 * - 'completed' is ONLY reachable from 'downloading' (or completed self-transition).
 * - Unknown values, prototype keys, and non-strings return false.
 */
export function canTransitionJobPhase(from: JobPhase, to: JobPhase): boolean {
  if (typeof from !== 'string' || typeof to !== 'string') {
    return false;
  }
  if (!ALL_PHASES.has(from as JobPhase) || !ALL_PHASES.has(to as JobPhase)) {
    return false;
  }

  // Idempotent self-transition for recognized phases
  if (from === to) {
    return true;
  }

  // Terminal phases cannot transition to any different phase
  if (TERMINAL_PHASES.has(from as JobPhase)) {
    return false;
  }

  // Idle cannot claim terminal results; can only transition to authenticating
  if (from === 'idle') {
    return to === 'authenticating';
  }

  // Active phase transitions
  if (ACTIVE_PHASES.has(from as JobPhase)) {
    if (NEXT_SEQUENTIAL_PHASE.get(from as JobPhase) === to) {
      return true;
    }
    if (ABORTIVE_TERMINAL_PHASES.has(to as JobPhase)) {
      return true;
    }
  }

  return false;
}

/**
 * Asserts that a phase transition is legal.
 * Throws a new static DomainError('INTERNAL_ERROR') on invalid or malformed transitions.
 * Does not echo or stringify raw values or invoke external hooks.
 */
export function assertJobTransition(from: JobPhase, to: JobPhase): void {
  if (!canTransitionJobPhase(from, to)) {
    throw new DomainError('INTERNAL_ERROR');
  }
}

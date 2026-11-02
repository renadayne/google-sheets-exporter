/**
 * T30a Pure Job Phase Transitions Unit Tests
 */

import { describe, it, expect, vi } from 'vitest';
import {
  type JobPhase,
  isTerminalJobPhase,
  canTransitionJobPhase,
  assertJobTransition,
} from '../../src/jobs/job-phase.ts';
import { DomainError } from '../../src/contracts/errors.ts';

describe('T30a pure job phase transitions', () => {
  it('group 1: complete legal sequential flow advances step-by-step', () => {
    const sequentialPath: readonly JobPhase[] = [
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
    ];

    // Every sequential forward hop is legal, non-terminal until completed
    for (let i = 0; i < sequentialPath.length - 1; i++) {
      const from = sequentialPath[i];
      const to = sequentialPath[i + 1];

      expect(isTerminalJobPhase(from)).toBe(false);
      expect(canTransitionJobPhase(from, to)).toBe(true);
      expect(() => assertJobTransition(from, to)).not.toThrow();
    }

    // Final phase completed is terminal
    expect(isTerminalJobPhase('completed')).toBe(true);

    // Arbitrary forward skips across the sequential chain must be rejected
    expect(canTransitionJobPhase('idle', 'checking_permission')).toBe(false);
    expect(() => assertJobTransition('idle', 'checking_permission')).toThrow(DomainError);

    expect(canTransitionJobPhase('authenticating', 'ready')).toBe(false);
    expect(() => assertJobTransition('authenticating', 'ready')).toThrow(DomainError);

    expect(canTransitionJobPhase('discovering', 'reading')).toBe(false);
    expect(() => assertJobTransition('discovering', 'reading')).toThrow(DomainError);

    expect(canTransitionJobPhase('planning', 'serializing')).toBe(false);
    expect(() => assertJobTransition('planning', 'serializing')).toThrow(DomainError);

    expect(canTransitionJobPhase('reading', 'downloading')).toBe(false);
    expect(() => assertJobTransition('reading', 'downloading')).toThrow(DomainError);

    // Backward transitions across the sequential chain must be rejected
    expect(canTransitionJobPhase('reading', 'planning')).toBe(false);
    expect(() => assertJobTransition('reading', 'planning')).toThrow(DomainError);

    expect(canTransitionJobPhase('downloading', 'serializing')).toBe(false);
    expect(() => assertJobTransition('downloading', 'serializing')).toThrow(DomainError);

    expect(canTransitionJobPhase('authenticating', 'idle')).toBe(false);
    expect(() => assertJobTransition('authenticating', 'idle')).toThrow(DomainError);
  });

  it('group 2: cannot complete before downloading (esp serializing and final_check)', () => {
    // Phases prior to downloading cannot leap directly to completed
    const nonDownloadingPredecessors: readonly JobPhase[] = [
      'idle',
      'authenticating',
      'checking_permission',
      'discovering',
      'ready',
      'planning',
      'reading',
      'serializing',
      'final_check',
    ];

    for (const phase of nonDownloadingPredecessors) {
      expect(canTransitionJobPhase(phase, 'completed')).toBe(false);
      let capturedError: unknown;
      try {
        assertJobTransition(phase, 'completed');
      } catch (err) {
        capturedError = err;
      }
      expect(capturedError).toBeInstanceOf(DomainError);
      expect((capturedError as DomainError).code).toBe('INTERNAL_ERROR');
    }

    // Only downloading is permitted to transition to completed
    expect(canTransitionJobPhase('downloading', 'completed')).toBe(true);
    expect(() => assertJobTransition('downloading', 'completed')).not.toThrow();

    // Completed self-transition is also allowed (idempotence)
    expect(canTransitionJobPhase('completed', 'completed')).toBe(true);
    expect(() => assertJobTransition('completed', 'completed')).not.toThrow();
  });

  it('group 3: terminal phases cannot reactivate, reset, or hide partial failure', () => {
    const terminals: readonly JobPhase[] = [
      'completed',
      'restricted',
      'uncertain',
      'failed',
      'cancelled',
      'interrupted',
    ];

    for (const term of terminals) {
      expect(isTerminalJobPhase(term)).toBe(true);

      // Cannot reactivate to idle (fresh job requires a new instance, no reset loophole)
      expect(canTransitionJobPhase(term, 'idle')).toBe(false);
      expect(() => assertJobTransition(term, 'idle')).toThrow(DomainError);

      // Cannot reactivate to authenticating or any active phase
      expect(canTransitionJobPhase(term, 'authenticating')).toBe(false);
      expect(() => assertJobTransition(term, 'authenticating')).toThrow(DomainError);

      expect(canTransitionJobPhase(term, 'reading')).toBe(false);
      expect(() => assertJobTransition(term, 'reading')).toThrow(DomainError);

      expect(canTransitionJobPhase(term, 'downloading')).toBe(false);
      expect(() => assertJobTransition(term, 'downloading')).toThrow(DomainError);

      // Cannot transition across to any other terminal phase
      for (const otherTerm of terminals) {
        if (otherTerm !== term) {
          expect(canTransitionJobPhase(term, otherTerm)).toBe(false);
          expect(() => assertJobTransition(term, otherTerm)).toThrow(DomainError);
        }
      }
    }

    // Specifically: partial failure, interruption, or cancellation cannot be masked as completed
    expect(canTransitionJobPhase('failed', 'completed')).toBe(false);
    expect(canTransitionJobPhase('interrupted', 'completed')).toBe(false);
    expect(canTransitionJobPhase('cancelled', 'completed')).toBe(false);
    expect(canTransitionJobPhase('restricted', 'completed')).toBe(false);
    expect(canTransitionJobPhase('uncertain', 'completed')).toBe(false);
  });

  it('group 4: cancellation, restriction, and uncertainty branches from active phases', () => {
    const activePhases: readonly JobPhase[] = [
      'authenticating',
      'checking_permission',
      'discovering',
      'ready',
      'planning',
      'reading',
      'serializing',
      'final_check',
      'downloading',
    ];

    const abortiveTerminals: readonly JobPhase[] = [
      'restricted',
      'uncertain',
      'failed',
      'cancelled',
      'interrupted',
    ];

    // Every active phase can branch to any abortive terminal
    for (const active of activePhases) {
      expect(isTerminalJobPhase(active)).toBe(false);

      for (const terminal of abortiveTerminals) {
        expect(canTransitionJobPhase(active, terminal)).toBe(true);
        expect(() => assertJobTransition(active, terminal)).not.toThrow();
      }
    }

    // Idle cannot claim terminal results
    for (const terminal of abortiveTerminals) {
      expect(canTransitionJobPhase('idle', terminal)).toBe(false);
      let capturedError: unknown;
      try {
        assertJobTransition('idle', terminal);
      } catch (err) {
        capturedError = err;
      }
      expect(capturedError).toBeInstanceOf(DomainError);
      expect((capturedError as DomainError).code).toBe('INTERNAL_ERROR');
    }
  });

  it('group 5: idempotent self-transitions permitted for recognized phases only', () => {
    const allKnownPhases: readonly JobPhase[] = [
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
    ];

    expect(allKnownPhases).toHaveLength(16);

    for (const phase of allKnownPhases) {
      expect(canTransitionJobPhase(phase, phase)).toBe(true);
      expect(() => assertJobTransition(phase, phase)).not.toThrow();
    }

    // Unrecognized self-transitions must be rejected
    const unknownPhases = ['in_progress', 'pending', 'paused', 'aborted', ''];
    for (const unknown of unknownPhases) {
      expect(canTransitionJobPhase(unknown as JobPhase, unknown as JobPhase)).toBe(false);
      expect(() => assertJobTransition(unknown as JobPhase, unknown as JobPhase)).toThrow(DomainError);
    }
  });

  it('group 6: unknown values, prototype keys, and hostile objects invoke no hooks and throw static error', () => {
    // Prototype pollution & property collision keys
    const prototypeCollisions = [
      'toString',
      'valueOf',
      'constructor',
      '__proto__',
      'isPrototypeOf',
      'hasOwnProperty',
      'propertyIsEnumerable',
    ];

    for (const key of prototypeCollisions) {
      expect(isTerminalJobPhase(key as JobPhase)).toBe(false);
      expect(canTransitionJobPhase(key as JobPhase, 'idle')).toBe(false);
      expect(canTransitionJobPhase('idle', key as JobPhase)).toBe(false);
      expect(canTransitionJobPhase(key as JobPhase, key as JobPhase)).toBe(false);

      expect(() => assertJobTransition(key as JobPhase, 'idle')).toThrow(DomainError);
      expect(() => assertJobTransition('idle', key as JobPhase)).toThrow(DomainError);
    }

    // Primitive non-string and malformed types
    const malformedValues = [null, undefined, 42, NaN, true, false, Symbol('phase'), [], {}];

    for (const malformed of malformedValues) {
      expect(isTerminalJobPhase(malformed as unknown as JobPhase)).toBe(false);
      expect(canTransitionJobPhase(malformed as unknown as JobPhase, 'idle')).toBe(false);
      expect(canTransitionJobPhase('idle', malformed as unknown as JobPhase)).toBe(false);

      expect(() => assertJobTransition(malformed as unknown as JobPhase, 'idle')).toThrow(DomainError);
      expect(() => assertJobTransition('idle', malformed as unknown as JobPhase)).toThrow(DomainError);
    }

    // Hostile object with spying getters that throw if accessed or stringified
    const hostileSpy = vi.fn();
    const hostileObject = {
      get toString() {
        hostileSpy('toString');
        throw new Error('hostile toString invoked');
      },
      get valueOf() {
        hostileSpy('valueOf');
        throw new Error('hostile valueOf invoked');
      },
      [Symbol.toPrimitive]() {
        hostileSpy('Symbol.toPrimitive');
        throw new Error('hostile Symbol.toPrimitive invoked');
      },
      get name() {
        hostileSpy('name');
        throw new Error('hostile name invoked');
      },
    };

    expect(isTerminalJobPhase(hostileObject as unknown as JobPhase)).toBe(false);
    expect(canTransitionJobPhase(hostileObject as unknown as JobPhase, 'idle')).toBe(false);
    expect(canTransitionJobPhase('idle', hostileObject as unknown as JobPhase)).toBe(false);
    expect(hostileSpy).not.toHaveBeenCalled();

    let thrown: unknown;
    try {
      assertJobTransition(hostileObject as unknown as JobPhase, 'idle');
    } catch (err) {
      thrown = err;
    }

    expect(hostileSpy).not.toHaveBeenCalled();
    expect(thrown).toBeInstanceOf(DomainError);
    expect((thrown as DomainError).code).toBe('INTERNAL_ERROR');
    expect((thrown as DomainError).message).toBe('An unexpected internal error occurred.');
  });
});

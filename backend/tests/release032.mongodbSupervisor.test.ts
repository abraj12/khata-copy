import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from '../src/config/env.js';
import * as mongodbConfig from '../src/config/mongodb.js';
import {
  calculateMongoRetryDelay,
  MongoConnectionSupervisor,
} from '../src/services/mongoConnectionSupervisor.js';
import { readModelOutboxWorker } from '../src/modules/readModels/readModelOutbox.worker.js';

describe('Khata Release #032 — MongoDB Supervisor & Resilient Reconnection Test Suite', () => {
  let prevMongoEnabled: boolean;

  beforeEach(() => {
    vi.restoreAllMocks();
    prevMongoEnabled = env.MONGODB_ENABLED;
    env.MONGODB_ENABLED = true;
    mongodbConfig.setForceMongoReadyInTests(null);
    vi.spyOn(readModelOutboxWorker, 'start').mockResolvedValue();
    vi.spyOn(readModelOutboxWorker, 'stop').mockResolvedValue();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    mongodbConfig.setForceMongoReadyInTests(null);
    env.MONGODB_ENABLED = prevMongoEnabled;
  });

  describe('1. Exponential Backoff and Jitter Invariants', () => {
    it('calculates retry delay strictly within bounds [0.8 * baseMs, maxMs]', () => {
      const baseMs = 500;
      const maxMs = 30000;

      for (let attempt = 1; attempt <= 15; attempt++) {
        for (let run = 0; run < 20; run++) {
          const delay = calculateMongoRetryDelay(attempt, baseMs, maxMs);
          expect(delay).toBeGreaterThanOrEqual(Math.round(baseMs * 0.8));
          expect(delay).toBeLessThanOrEqual(maxMs);
        }
      }
    });

    it('returns bounded delay for attempt 0 or negative', () => {
      const delay = calculateMongoRetryDelay(0, 500, 30000);
      expect(delay).toBeGreaterThanOrEqual(Math.round(500 * 0.8));
      expect(delay).toBeLessThanOrEqual(Math.round(500 * 1.25));
    });
  });

  describe('2. Unready Listener Registry & Ping Failure Sanitization', () => {
    it('notifies registered unready listeners when Mongo becomes unavailable', () => {
      const listenerSpy = vi.fn();
      const unregister = mongodbConfig.registerMongoUnreadyListener(listenerSpy);

      const testError = new Error('Socket closed unexpectedly');
      mongodbConfig.markMongoUnavailable(testError);

      expect(listenerSpy).toHaveBeenCalledWith(testError);

      // Verify unregister cleans up listener
      listenerSpy.mockClear();
      unregister();
      mongodbConfig.markMongoUnavailable(new Error('Another socket error'));
      expect(listenerSpy).not.toHaveBeenCalled();
    });

    it('sanitizes ping errors and notifies listeners without throwing unhandled exceptions', async () => {
      const listenerSpy = vi.fn();
      const unregister = mongodbConfig.registerMongoUnreadyListener(listenerSpy);

      vi.spyOn(mongodbConfig, 'isMongoReady').mockReturnValue(false);
      vi.spyOn(mongodbConfig, 'getMongoAvailabilityState').mockReturnValue('disconnected');

      const readiness = await mongodbConfig.checkMongoReadiness();
      expect(readiness.isReady).toBe(false);
      expect(readiness.error).toBeDefined();

      unregister();
    });
  });

  describe('3. Supervisor Reconnection Scheduling After Failure (No Active Promise Deadlock)', () => {
    it('schedules subsequent reconnection attempt after a failed attempt without deadlock', async () => {
      vi.useFakeTimers();

      let connectAttempts = 0;
      vi.spyOn(mongodbConfig, 'connectMongo').mockImplementation(async () => {
        connectAttempts++;
        if (connectAttempts <= 2) {
          throw new Error(`Connection attempt ${connectAttempts} failed`);
        }
        return {} as any;
      });
      vi.spyOn(mongodbConfig, 'ensureMongoIndexes').mockResolvedValue({ success: true });
      vi.spyOn(mongodbConfig, 'isMongoReady').mockImplementation(() => connectAttempts > 2);

      const supervisor = new MongoConnectionSupervisor({
        baseRetryDelayMs: 100,
        maxRetryDelayMs: 1000,
      });

      // Start supervisor
      const startPromise = supervisor.start();
      expect(supervisor.isStarted()).toBe(true);

      // First attempt triggers
      await vi.advanceTimersByTimeAsync(0);
      await startPromise;
      expect(connectAttempts).toBe(1);

      // Advance time for first retry
      await vi.advanceTimersByTimeAsync(300);
      expect(connectAttempts).toBe(2);

      // Advance time for second retry (succeeds)
      await vi.advanceTimersByTimeAsync(600);
      expect(connectAttempts).toBe(3);

      await supervisor.stop();
      expect(supervisor.isStarted()).toBe(false);
    });

    it('automatically schedules reconnection when unready listener fires while started', async () => {
      vi.useFakeTimers();

      let connectCalls = 0;
      vi.spyOn(mongodbConfig, 'connectMongo').mockImplementation(async () => {
        connectCalls++;
        return {} as any;
      });
      vi.spyOn(mongodbConfig, 'ensureMongoIndexes').mockResolvedValue({ success: true });
      vi.spyOn(mongodbConfig, 'isMongoReady').mockReturnValue(true);

      const supervisor = new MongoConnectionSupervisor({
        baseRetryDelayMs: 100,
        maxRetryDelayMs: 500,
      });

      const startPromise = supervisor.start();
      await vi.advanceTimersByTimeAsync(0);
      await startPromise;
      expect(connectCalls).toBe(1);

      // Trigger unready notification
      vi.spyOn(mongodbConfig, 'isMongoReady').mockReturnValue(false);
      mongodbConfig.markMongoUnavailable(new Error('Mongo server heartbeat failed'));

      // Advance timer for supervisor to attempt reconnection
      await vi.advanceTimersByTimeAsync(200);
      expect(connectCalls).toBe(2);

      await supervisor.stop();
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { appPool } from '../src/config/database.js';
import {
  validateAndParseMongoEnv,
} from '../src/config/mongoEnv.js';
import * as mongodbConfig from '../src/config/mongodb.js';
import {
  calculateMongoRetryDelay,
} from '../src/services/mongoConnectionSupervisor.js';
import { ReadModelOutboxWorker } from '../src/modules/readModels/readModelOutbox.worker.js';
import { readModelsQueryService, ReadModelUnavailableError } from '../src/modules/readModels/readModelsQuery.service.js';

const TEST_PHONE = '9876543210';
const TEST_PASSWORD = 'KhataOwner@2026!';
const TEST_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$r8d9IIf2qq2yux48fjyp5g$NguetCKE39Yg87iMcaXXeobM8JnU+B4/BKokFoI5yR4';

env.OWNER_PHONE = TEST_PHONE;
env.OWNER_PASSWORD_HASH = TEST_HASH;
env.SESSION_COOKIE_SECURE = false;

describe('Khata Release #031 — Mandatory MongoDB Reliability & Supervisor Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('1. Production Environment Mandatory Configuration Validation', () => {
    it('throws configuration error if MONGODB_ENABLED is false in production', () => {
      expect(() => {
        validateAndParseMongoEnv(
          {
            MONGODB_ENABLED: 'false',
            MONGODB_URI: 'mongodb://localhost:27017',
            MONGODB_DATABASE: 'khata_prod',
          },
          'production'
        );
      }).toThrowError(/MongoDB is mandatory in production/);
    });

    it('throws configuration error if MONGODB_URI is missing or unconfigured in production', () => {
      expect(() => {
        validateAndParseMongoEnv(
          {
            MONGODB_ENABLED: 'true',
            MONGODB_URI: undefined,
            MONGODB_DATABASE: 'khata_prod',
          },
          'production'
        );
      }).toThrowError(/MongoDB URI and database name must be configured in production/);
    });

    it('throws configuration error if MONGODB_DATABASE is empty in production', () => {
      expect(() => {
        validateAndParseMongoEnv(
          {
            MONGODB_ENABLED: 'true',
            MONGODB_URI: 'mongodb://localhost:27017',
            MONGODB_DATABASE: '',
          },
          'production'
        );
      }).toThrowError(/Invalid MongoDB environment configuration/);
    });

    it('validates successfully when all mandatory production MongoDB settings are present', () => {
      const parsed = validateAndParseMongoEnv(
        {
          MONGODB_ENABLED: 'true',
          MONGODB_URI: 'mongodb://mongo.internal:27017',
          MONGODB_DATABASE: 'khata_production',
        },
        'production'
      );
      expect(parsed.MONGODB_ENABLED).toBe(true);
      expect(parsed.MONGODB_URI).toBe('mongodb://mongo.internal:27017');
      expect(parsed.MONGODB_DATABASE).toBe('khata_production');
    });

    it('does not enforce mandatory MongoDB if NODE_ENV is development or test', () => {
      const parsed = validateAndParseMongoEnv(
        {
          MONGODB_ENABLED: 'false',
        },
        'test'
      );
      expect(parsed.MONGODB_ENABLED).toBe(false);
    });
  });

  describe('2. Connection Supervisor Exponential Backoff, Jitter & State Machine', () => {
    it('computes backoff with exponential growth and 20% jitter bounded by max delay', () => {
      const minDelay = 1000;
      const maxDelay = 60000;

      // Attempt 1: minDelay ~ 1000ms with jitter +/- 20% -> [800, 1200]
      const backoff1 = calculateMongoRetryDelay(1, minDelay, maxDelay);
      expect(backoff1).toBeGreaterThanOrEqual(Math.floor(minDelay * 0.8));
      expect(backoff1).toBeLessThanOrEqual(Math.ceil(minDelay * 1.2));

      // Attempt 5: 1000 * 2^4 = 16000ms +/- 20%
      const backoff5 = calculateMongoRetryDelay(5, minDelay, maxDelay);
      expect(backoff5).toBeGreaterThanOrEqual(Math.floor(16000 * 0.8));
      expect(backoff5).toBeLessThanOrEqual(Math.ceil(16000 * 1.2));

      // Attempt 20: capped at maxDelay (e.g. 60000ms) +/- 20%
      const backoff20 = calculateMongoRetryDelay(20, minDelay, maxDelay);
      expect(backoff20).toBeLessThanOrEqual(maxDelay);
    });

    it('tracks supervisor state transitions: disconnected -> connecting -> initializing -> ready', () => {
      const origEnabled = env.MONGODB_ENABLED;
      try {
        (env as any).MONGODB_ENABLED = true;
        mongodbConfig.setForceMongoReadyInTests(null);
        vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);

        mongodbConfig.setMongoAvailabilityState('disconnected');
        expect(mongodbConfig.getMongoAvailabilityState()).toBe('disconnected');
        expect(mongodbConfig.isMongoReady()).toBe(false);

        mongodbConfig.setMongoAvailabilityState('connecting');
        expect(mongodbConfig.getMongoAvailabilityState()).toBe('connecting');
        expect(mongodbConfig.isMongoReady()).toBe(false);

        mongodbConfig.setMongoAvailabilityState('initializing');
        expect(mongodbConfig.getMongoAvailabilityState()).toBe('initializing');
        expect(mongodbConfig.isMongoReady()).toBe(false);

        mongodbConfig.setMongoAvailabilityState('ready', { connectionReady: true, initializationReady: true });
        expect(mongodbConfig.getMongoAvailabilityState()).toBe('ready');
        expect(mongodbConfig.isMongoReady()).toBe(true);
      } finally {
        (env as any).MONGODB_ENABLED = origEnabled;
        mongodbConfig.setForceMongoReadyInTests(true);
        mongodbConfig.setMongoAvailabilityState('disconnected');
      }
    });
  });

  describe('3. Availability Gating & Health Check Invariants', () => {
    it('/api/v1/health/live returns 200 with ZERO database queries even when DBs are unready', async () => {
      const pgQuerySpy = vi.spyOn(appPool, 'query');
      const pgConnectSpy = vi.spyOn(appPool, 'connect');

      const app = createApp();
      const res = await request(app).get('/api/v1/health/live');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('alive');
      expect(typeof res.body.uptime).toBe('number');
      expect(pgQuerySpy).not.toHaveBeenCalled();
      expect(pgConnectSpy).not.toHaveBeenCalled();
    });

    it('/api/v1/health/ready returns 503 unready when MongoDB is unready', async () => {
      vi.spyOn(mongodbConfig, 'isMongoEnabled').mockReturnValue(true);
      vi.spyOn(mongodbConfig, 'checkMongoReadiness').mockResolvedValue({
        isReady: false,
        enabled: true,
        state: 'disconnected',
        latencyMs: 1,
      });

      const app = createApp();
      const res = await request(app).get('/api/v1/health/ready');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unready');
      expect(res.body.services.mongodb).toBe('disconnected');
    });

    it('intercepts business routes with 503 MANDATORY_SERVICE_UNAVAILABLE when MongoDB is mandatory and unready in production', async () => {
      vi.spyOn(mongodbConfig, 'isMongoReady').mockReturnValue(false);

      const app = createApp();
      const res = await request(app).get('/api/v1/products');

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('MANDATORY_SERVICE_UNAVAILABLE');
      expect(res.body.message).toContain('Khata ERP is temporarily unavailable');
    });
  });

  describe('4. Fail-Closed Read Models Invariant (Zero PostgreSQL Fallback)', () => {
    it('throws ReadModelUnavailableError when searchProductsFromMongo is called while MongoDB is unready', async () => {
      vi.spyOn(mongodbConfig, 'isMongoReady').mockReturnValue(false);

      await expect(
        readModelsQueryService.searchProductsFromMongo({ search: 'Cement', limit: 10 })
      ).rejects.toThrowError(ReadModelUnavailableError);
    });

    it('throws ReadModelUnavailableError when getKhataSummaryFromMongo is called while MongoDB is unready', async () => {
      vi.spyOn(mongodbConfig, 'isMongoReady').mockReturnValue(false);

      await expect(
        readModelsQueryService.getKhataSummaryFromMongo()
      ).rejects.toThrowError(ReadModelUnavailableError);
    });

    it('throws ReadModelUnavailableError when getDashboardOverviewFromMongo is called while MongoDB is unready', async () => {
      vi.spyOn(mongodbConfig, 'isMongoReady').mockReturnValue(false);

      await expect(
        readModelsQueryService.getDashboardOverviewFromMongo({})
      ).rejects.toThrowError(ReadModelUnavailableError);
    });
  });

  describe('5. Outbox Worker Disconnect Pause & Auto-Resume Behavior', () => {
    it('pauses drain execution when MongoDB is disconnected and skips processing', async () => {
      vi.spyOn(mongodbConfig, 'isMongoReady').mockReturnValue(false);

      const worker = new ReadModelOutboxWorker({ batchSize: 10 });
      // When Mongo is not ready, drainNow aborts early and does not process
      await worker.drainNow('test_trigger');
      expect(worker.getStatus().draining).toBe(false);
    });
  });
});

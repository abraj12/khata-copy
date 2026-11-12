import mongoose from 'mongoose';
import { env } from '../config/env.js';
import {
  connectMongo,
  ensureMongoIndexes,
  getMongoAvailabilityState,
  isMongoEnabled,
  isMongoReady,
  redactMongoUri,
  registerMongoUnreadyListener,
  setMongoAvailabilityState,
} from '../config/mongodb.js';
import { readModelOutboxWorker } from '../modules/readModels/readModelOutbox.worker.js';

/**
 * Calculates exponential backoff delay with uniform jitter.
 * Formula: delay = min(maxMs, min(maxMs, baseMs * 2^(attempt-1)) * (0.8 + 0.4 * random))
 */
export function calculateMongoRetryDelay(
  attempt: number,
  baseMs = 1000,
  maxMs = 60000
): number {
  const safeAttempt = Math.max(1, Math.trunc(attempt));
  const exponential = Math.min(maxMs, baseMs * Math.pow(2, safeAttempt - 1));
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.min(maxMs, Math.round(exponential * jitter));
}

export interface MongoSupervisorOptions {
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

/**
 * Supervised lifecycle manager for mandatory MongoDB connection & index initialization.
 * Automatically handles startup failure without terminating the Node.js process,
 * monitors connection drop/recovery, safely coordinates outbox worker pauses & restarts,
 * and maintains application readiness state.
 */
export class MongoConnectionSupervisor {
  private started = false;
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private activeReconnectPromise: Promise<void> | null = null;
  private listenersAttached = false;
  private unregisterUnreadyListener: (() => void) | null = null;

  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;

  constructor(options: MongoSupervisorOptions = {}) {
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 1000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 60000;
  }

  public isStarted(): boolean {
    return this.started;
  }

  public async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.reconnectAttempt = 0;

    if (!isMongoEnabled()) {
      setMongoAvailabilityState('disabled');
      return;
    }

    this.attachMongooseListeners();

    if (!this.unregisterUnreadyListener) {
      this.unregisterUnreadyListener = registerMongoUnreadyListener(() => {
        if (this.stopped) return;
        void readModelOutboxWorker.stop().catch(() => {});
        this.scheduleReconnect();
      });
    }

    // Initial connection attempt on startup
    await this.triggerConnectionAttempt();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    this.clearReconnectTimer();

    if (this.unregisterUnreadyListener) {
      this.unregisterUnreadyListener();
      this.unregisterUnreadyListener = null;
    }

    if (this.activeReconnectPromise) {
      try {
        await this.activeReconnectPromise;
      } catch {
        // Ignore shutdown errors
      }
    }

    // Safely stop read-model worker
    await readModelOutboxWorker.stop().catch(() => {});
  }

  public clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private attachMongooseListeners(): void {
    if (this.listenersAttached) return;
    this.listenersAttached = true;

    mongoose.connection.on('disconnected', () => {
      if (this.stopped) return;
      console.warn('[MONGO SUPERVISOR] MongoDB disconnected; marking unready and pausing worker.');
      setMongoAvailabilityState('disconnected', { connectionReady: false, initializationReady: false });
      void readModelOutboxWorker.stop().catch(() => {});
      this.scheduleReconnect();
    });

    mongoose.connection.on('error', (err) => {
      if (this.stopped) return;
      console.error('[MONGO SUPERVISOR] Mongoose connection error:', (err as Error)?.message);
      if (mongoose.connection.readyState !== 1) {
        setMongoAvailabilityState('disconnected', { connectionReady: false, initializationReady: false });
        void readModelOutboxWorker.stop().catch(() => {});
        this.scheduleReconnect();
      }
    });
  }

  public scheduleReconnect(): void {
    if (
      this.stopped ||
      !isMongoEnabled() ||
      this.reconnectTimer ||
      this.activeReconnectPromise
    ) {
      return;
    }

    this.reconnectAttempt += 1;
    const delayMs = calculateMongoRetryDelay(
      this.reconnectAttempt,
      this.baseRetryDelayMs,
      this.maxRetryDelayMs
    );

    console.log(
      `[MONGO SUPERVISOR] Scheduling reconnect attempt #${this.reconnectAttempt} in ${delayMs}ms.`
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) {
        void this.triggerConnectionAttempt();
      }
    }, delayMs);

    if (typeof this.reconnectTimer.unref === 'function') {
      this.reconnectTimer.unref();
    }
  }

  public async triggerConnectionAttempt(): Promise<void> {
    if (this.stopped || !isMongoEnabled()) {
      return;
    }

    if (this.activeReconnectPromise) {
      return this.activeReconnectPromise;
    }

    let attemptPromise!: Promise<void>;

    attemptPromise = this.performConnectionAttempt();
    this.activeReconnectPromise = attemptPromise;

    try {
      await attemptPromise;
    } finally {
      if (this.activeReconnectPromise === attemptPromise) {
        this.activeReconnectPromise = null;
      }

      // Schedule retry only AFTER clearing the active promise
      if (
        !this.stopped &&
        isMongoEnabled() &&
        !isMongoReady() &&
        !this.reconnectTimer
      ) {
        this.scheduleReconnect();
      }
    }
  }

  private async performConnectionAttempt(): Promise<void> {
    try {
      if (this.stopped || !isMongoEnabled()) {
        return;
      }

      setMongoAvailabilityState('connecting');

      if (mongoose.connection.readyState !== 1) {
        await connectMongo({ maxRetries: 1 });
      } else {
        const indexResult = await ensureMongoIndexes();
        if (!indexResult.success) {
          throw new Error(
            `MongoDB index initialization failed: ${indexResult.error}`
          );
        }
      }

      // Explicit ping during readiness restoration
      if (mongoose.connection.db) {
        await mongoose.connection.db.admin().ping();
      }

      if (!isMongoReady()) {
        throw new Error(
          'MongoDB connection or initialization did not reach ready state.'
        );
      }

      this.reconnectAttempt = 0;
      this.clearReconnectTimer();

      console.log(
        '[MONGO SUPERVISOR] MongoDB is fully ready. Starting read-model worker.'
      );

      readModelOutboxWorker.start();
    } catch (err) {
      if (mongoose.connection.readyState === 1) {
        setMongoAvailabilityState('degraded', {
          connectionReady: true,
          initializationReady: false,
        });
      } else {
        setMongoAvailabilityState('disconnected', {
          connectionReady: false,
          initializationReady: false,
        });
      }

      console.error('[MONGO SUPERVISOR] Connection attempt failed:', {
        target: redactMongoUri(env.MONGODB_URI),
        message: (err as Error)?.message,
      });

      await readModelOutboxWorker.stop().catch(() => {});
    }
  }
}

export const mongoConnectionSupervisor = new MongoConnectionSupervisor();

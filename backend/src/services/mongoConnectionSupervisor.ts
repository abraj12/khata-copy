import mongoose from 'mongoose';
import { env } from '../config/env.js';
import {
  connectMongo,
  ensureMongoIndexes,
  getMongoAvailabilityState,
  isMongoEnabled,
  isMongoReady,
  redactMongoUri,
  setMongoAvailabilityState,
} from '../config/mongodb.js';
import { readModelOutboxWorker } from '../modules/readModels/readModelOutbox.worker.js';

/**
 * Calculates exponential backoff delay with uniform jitter.
 * Formula: delay = min(maxMs, baseMs * 2^(attempt-1)) * (0.8 + 0.4 * random)
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

    // Initial connection attempt on startup
    await this.triggerConnectionAttempt();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    this.clearReconnectTimer();

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

  private clearReconnectTimer(): void {
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
    if (this.stopped || !isMongoEnabled() || this.reconnectTimer || this.activeReconnectPromise) {
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
    if (this.stopped || !isMongoEnabled()) return;
    if (this.activeReconnectPromise) {
      return this.activeReconnectPromise;
    }

    const runPromise = (async () => {
      try {
        setMongoAvailabilityState('connecting');

        if (mongoose.connection.readyState !== 1) {
          await connectMongo({ maxRetries: 1 });
        } else {
          // Connection is open; verify index initialization
          const indexRes = await ensureMongoIndexes();
          if (!indexRes.success) {
            throw new Error(`Index initialization failed: ${indexRes.error}`);
          }
        }

        if (isMongoReady()) {
          this.reconnectAttempt = 0;
          console.log('[MONGO SUPERVISOR] MongoDB is fully initialized & ready. Starting outbox worker.');
          readModelOutboxWorker.start();
        }
      } catch (err) {
        console.warn(
          `[MONGO SUPERVISOR] Connection/initialization attempt failed (target=${redactMongoUri(env.MONGODB_URI)}):`,
          (err as Error)?.message
        );
        if (mongoose.connection.readyState === 1) {
          setMongoAvailabilityState('degraded', { connectionReady: true, initializationReady: false });
        } else {
          setMongoAvailabilityState('disconnected', { connectionReady: false, initializationReady: false });
        }
        void readModelOutboxWorker.stop().catch(() => {});
        if (!this.stopped) {
          this.scheduleReconnect();
        }
      } finally {
        this.activeReconnectPromise = null;
      }
    })();

    this.activeReconnectPromise = runPromise;
    return runPromise;
  }
}

export const mongoConnectionSupervisor = new MongoConnectionSupervisor();

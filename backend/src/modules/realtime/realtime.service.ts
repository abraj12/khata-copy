import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { env } from '../../config/env.js';
import { requireOwnerSession } from '../../middleware/requireOwnerSession.js';

export interface SealedQueryToken {
  queryId: string;
  querySql: string;
  expiresAt: number;
  signature: string;
}

export class NeonRealtimeService {
  private realtimeSecret: string;
  private endpointUrl: string;

  constructor() {
    this.realtimeSecret = env.NEON_REALTIME_SECRET;
    this.endpointUrl = env.NEON_REALTIME_URL;
  }

  /**
   * Seals a whitelisted query for client real-time subscription.
   * Uses HMAC-SHA256 with the server-side NEON_REALTIME_SECRET.
   */
  public sealQuery(queryId: string, querySql: string, ttlSeconds = 3600): SealedQueryToken {
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    const payload = `${queryId}:${querySql}:${expiresAt}`;
    const signature = crypto
      .createHmac('sha256', this.realtimeSecret)
      .update(payload)
      .digest('hex');

    return {
      queryId,
      querySql,
      expiresAt,
      signature,
    };
  }

  /**
   * Verifies a sealed token signature.
   */
  public verifySealedToken(token: SealedQueryToken): boolean {
    const now = Math.floor(Date.now() / 1000);
    if (token.expiresAt < now) return false;

    const payload = `${token.queryId}:${token.querySql}:${token.expiresAt}`;
    const expected = crypto
      .createHmac('sha256', this.realtimeSecret)
      .update(payload)
      .digest('hex');

    return crypto.timingSafeEqual(Buffer.from(token.signature), Buffer.from(expected));
  }

  public getRealtimeEndpoint(): string {
    return this.endpointUrl;
  }
}

export const neonRealtimeService = new NeonRealtimeService();

// Realtime subscription endpoint for authenticated owner
const router = Router();
router.use(requireOwnerSession);

/**
 * GET /api/v1/realtime/subscribe/:topic
 * Returns sealed queries for authorized dashboard aggregates or ledger feeds
 */
router.get('/subscribe/:topic', (req: Request, res: Response) => {
  const { topic } = req.params;

  let querySql = '';
  if (topic === 'dashboard') {
    querySql = 'SELECT COUNT(*) as total_customers FROM customers';
  } else if (topic === 'ledger') {
    querySql = 'SELECT * FROM ledger_entries ORDER BY created_at DESC LIMIT 50';
  } else {
    res.status(400).json({ success: false, message: 'Invalid or unauthorized realtime topic.' });
    return;
  }

  const sealed = neonRealtimeService.sealQuery(topic, querySql);

  res.json({
    success: true,
    realtimeUrl: neonRealtimeService.getRealtimeEndpoint(),
    topic,
    sealedQuery: sealed,
    notes: 'Neon Realtime is in beta. Authenticated REST fallback is active.',
  });
});

export const realtimeRoutes = router;

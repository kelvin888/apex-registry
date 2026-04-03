/**
 * Notifications Service
 *
 * In-app notification store, push token registration, notification
 * preferences, and notification delivery. Push delivery (FCM/APNs)
 * is handled externally — this service manages the data layer and
 * exposes a `createNotification` helper for other services to
 * generate transactional notifications.
 *
 * All timestamps are JavaScript Date objects (Drizzle integer mode: 'timestamp').
 */

import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  getDatabase,
  notifications,
  pushTokens,
  notificationPreferences,
} from '../db';

// =============================================================================
// PUSH TOKEN REGISTRATION
// =============================================================================

export async function registerPush(
  userId: string,
  params: { token: string; platform: string; categories?: string[] },
) {
  const db = getDatabase();
  const now = new Date();

  // Upsert token — if same token exists, just update ownership
  const existing = await db
    .select()
    .from(pushTokens)
    .where(eq(pushTokens.token, params.token))
    .get();

  if (existing) {
    await db
      .update(pushTokens)
      .set({ userId, platform: params.platform as any, active: true, updatedAt: now })
      .where(eq(pushTokens.id, existing.id));
  } else {
    await db.insert(pushTokens).values({
      id: nanoid(),
      userId,
      token: params.token,
      platform: params.platform as any,
      active: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  // If categories specified, ensure preferences exist for them (default enabled)
  if (params.categories && params.categories.length > 0) {
    for (const cat of params.categories) {
      const pref = await db
        .select()
        .from(notificationPreferences)
        .where(and(eq(notificationPreferences.userId, userId), eq(notificationPreferences.category, cat as any)))
        .get();

      if (!pref) {
        await db.insert(notificationPreferences).values({
          id: nanoid(),
          userId,
          category: cat as any,
          pushEnabled: true,
          inAppEnabled: true,
          updatedAt: now,
        });
      }
    }
  }

  return { success: true, registered: true };
}

// =============================================================================
// GET NOTIFICATIONS
// =============================================================================

export async function getNotifications(
  userId: string,
  params: {
    type?: string;
    status?: string;
    limit?: number;
    offset?: number;
  },
) {
  const db = getDatabase();

  const limit = Math.min(params.limit || 20, 100);
  const offset = params.offset || 0;

  const conditions = [eq(notifications.userId, userId)];
  if (params.type) {
    conditions.push(eq(notifications.type, params.type as any));
  }
  if (params.status) {
    conditions.push(eq(notifications.status, params.status as any));
  }

  const where = conditions.length === 1 ? conditions[0] : and(...conditions);

  const [rows, countResult, unreadResult] = await Promise.all([
    db
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt))
      .limit(limit)
      .offset(offset)
      .all(),
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(notifications)
      .where(where)
      .get(),
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.status, 'unread')))
      .get(),
  ]);

  const total = countResult?.count ?? 0;
  const unreadCount = unreadResult?.count ?? 0;

  const mapped = rows.map((n) => ({
    notificationId: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    status: n.status,
    deepLink: n.deepLink ?? undefined,
    timestamp: n.createdAt.getTime(),
    metadata: n.metadata ? JSON.parse(n.metadata) : undefined,
  }));

  return {
    notifications: mapped,
    unreadCount,
    total,
    hasMore: offset + limit < total,
  };
}

// =============================================================================
// MARK READ
// =============================================================================

export async function markRead(userId: string, notificationIds: string[]) {
  const db = getDatabase();

  // Only update notifications belonging to this user
  const result = await db
    .update(notifications)
    .set({ status: 'read' })
    .where(
      and(
        eq(notifications.userId, userId),
        inArray(notifications.id, notificationIds),
        eq(notifications.status, 'unread'),
      ),
    );

  // Count how many were actually updated (SQLite returns changes via raw)
  const updated = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        inArray(notifications.id, notificationIds),
        eq(notifications.status, 'read'),
      ),
    )
    .get();

  return {
    success: true,
    updatedCount: updated?.count ?? 0,
  };
}

// =============================================================================
// SEND NOTIFICATION (from mini-app or internal)
// =============================================================================

export async function sendNotification(
  userId: string,
  params: {
    recipientId?: string;
    type: string;
    title: string;
    body: string;
    deepLink?: string;
    sourceAppId?: string;
    metadata?: Record<string, unknown>;
  },
) {
  const db = getDatabase();
  const recipientId = params.recipientId || userId;

  // Check recipient preference — if they opted out, skip in-app storage
  const pref = await db
    .select()
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.userId, recipientId),
        eq(notificationPreferences.category, params.type as any),
      ),
    )
    .get();

  // Default to enabled if no preference exists
  const inAppEnabled = pref?.inAppEnabled ?? true;

  let notificationId = '';

  if (inAppEnabled) {
    notificationId = `ntf_${nanoid(16)}`;
    await db.insert(notifications).values({
      id: notificationId,
      userId: recipientId,
      type: params.type as any,
      title: params.title,
      body: params.body,
      status: 'unread',
      deepLink: params.deepLink ?? null,
      sourceAppId: params.sourceAppId ?? null,
      metadata: params.metadata ? JSON.stringify(params.metadata) : null,
      createdAt: new Date(),
    });
  }

  // Push delivery would happen here (FCM/APNs) — for now just record.
  // In production: fetch push tokens for recipientId, check pushEnabled pref,
  // then dispatch to FCM/APNs.

  return {
    success: true,
    notificationId: notificationId || `ntf_skipped_${nanoid(8)}`,
  };
}

// =============================================================================
// GET / UPDATE PREFERENCES
// =============================================================================

export async function getPreferences(userId: string) {
  const db = getDatabase();

  const rows = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId))
    .all();

  // Build a map with defaults for missing categories
  const categories = ['transactional', 'promotional', 'system'] as const;
  const prefs = categories.map((cat) => {
    const existing = rows.find((r) => r.category === cat);
    return {
      category: cat,
      pushEnabled: existing?.pushEnabled ?? true,
      inAppEnabled: existing?.inAppEnabled ?? true,
    };
  });

  return { preferences: prefs };
}

export async function updatePreference(
  userId: string,
  params: { category: string; pushEnabled?: boolean; inAppEnabled?: boolean },
) {
  const db = getDatabase();
  const now = new Date();

  const existing = await db
    .select()
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.userId, userId),
        eq(notificationPreferences.category, params.category as any),
      ),
    )
    .get();

  const updates: Record<string, unknown> = { updatedAt: now };
  if (params.pushEnabled !== undefined) updates.pushEnabled = params.pushEnabled;
  if (params.inAppEnabled !== undefined) updates.inAppEnabled = params.inAppEnabled;

  if (existing) {
    await db
      .update(notificationPreferences)
      .set(updates)
      .where(eq(notificationPreferences.id, existing.id));
  } else {
    await db.insert(notificationPreferences).values({
      id: nanoid(),
      userId,
      category: params.category as any,
      pushEnabled: params.pushEnabled ?? true,
      inAppEnabled: params.inAppEnabled ?? true,
      updatedAt: now,
    });
  }

  return { success: true };
}

// =============================================================================
// CREATE NOTIFICATION (internal helper for other services)
// =============================================================================

/**
 * Called by wallet, credit, identity services to generate transactional
 * notifications for users (e.g. "Transfer of ₦5,000 completed").
 */
export async function createNotification(data: {
  userId: string;
  type: 'transactional' | 'promotional' | 'system';
  title: string;
  body: string;
  deepLink?: string;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const result = await sendNotification(data.userId, {
    ...data,
    recipientId: data.userId,
  });
  return result.notificationId;
}

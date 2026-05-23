/**
 * Savings Service
 *
 * Personal savings goals with auto-deduction, locked savings,
 * and Ajo/Esusu rotating savings groups.
 * Integrates wallet (debit/credit), history (receipts), notifications.
 */

import { eq, and, desc, sql, lte } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  getDatabase,
  savingsGoals,
  savingsTransactions,
  ajoGroups,
  ajoMembers,
  ajoContributions,
  wallets,
  walletTransactions,
  ledgerEntries,
  users,
  type SavingsGoal,
  type AjoGroup,
  type AjoMember,
} from '../db';
import { getOrCreateWallet } from './wallet';
import { createReceipt } from './history';
import { createNotification } from './notifications';

// =============================================================================
// Savings Goals
// =============================================================================

export async function createGoal(
  userId: string,
  opts: {
    name: string;
    targetAmount: number;
    currency?: string;
    deadline?: number;
    locked?: boolean;
    autoDeductFrequency?: 'none' | 'daily' | 'weekly' | 'monthly';
    autoDeductAmount?: number;
  },
) {
  const db = getDatabase();
  const now = new Date();
  const id = `SAV_${nanoid(16)}`;
  const currency = opts.currency || 'NGN';

  let nextDeductAt: Date | null = null;
  if (opts.autoDeductFrequency && opts.autoDeductFrequency !== 'none' && opts.autoDeductAmount) {
    nextDeductAt = computeNextDeduct(now, opts.autoDeductFrequency);
  }

  await db.insert(savingsGoals).values({
    id,
    userId,
    name: opts.name,
    targetAmount: opts.targetAmount,
    currentAmount: 0,
    currency,
    deadline: opts.deadline ? new Date(opts.deadline) : null,
    locked: opts.locked ?? false,
    autoDeductFrequency: opts.autoDeductFrequency || 'none',
    autoDeductAmount: opts.autoDeductAmount || null,
    nextDeductAt,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });

  return { id, name: opts.name, targetAmount: opts.targetAmount, currency, status: 'active' };
}

export async function getGoals(userId: string) {
  const db = getDatabase();
  return db
    .select()
    .from(savingsGoals)
    .where(eq(savingsGoals.userId, userId))
    .orderBy(desc(savingsGoals.createdAt));
}

export async function getGoal(userId: string, goalId: string) {
  const db = getDatabase();
  const [goal] = await db
    .select()
    .from(savingsGoals)
    .where(and(eq(savingsGoals.id, goalId), eq(savingsGoals.userId, userId)))
    .limit(1);

  if (!goal) throw Object.assign(new Error('Savings goal not found'), { statusCode: 404 });

  const txns = await db
    .select()
    .from(savingsTransactions)
    .where(eq(savingsTransactions.goalId, goalId))
    .orderBy(desc(savingsTransactions.createdAt));

  return { ...goal, transactions: txns };
}

export async function depositToGoal(
  userId: string,
  goalId: string,
  amount: number,
) {
  const db = getDatabase();
  const [goal] = await db
    .select()
    .from(savingsGoals)
    .where(and(eq(savingsGoals.id, goalId), eq(savingsGoals.userId, userId)))
    .limit(1);

  if (!goal) throw Object.assign(new Error('Savings goal not found'), { statusCode: 404 });
  if (goal.status !== 'active') throw Object.assign(new Error('Goal is not active'), { statusCode: 400 });

  const wallet = await getOrCreateWallet(userId, goal.currency);
  if (wallet.availableBalance < amount) {
    throw Object.assign(new Error('Insufficient wallet balance'), { statusCode: 400 });
  }

  const now = new Date();
  const txnRef = `SAVDEP_${nanoid(12)}`;
  const txnId = nanoid();

  // Debit wallet
  const newBalance = wallet.balance - amount;
  const newAvailable = wallet.availableBalance - amount;

  await db.insert(walletTransactions).values({
    id: txnId,
    walletId: wallet.id,
    type: 'payment' as const,
    amount,
    fee: 0,
    currency: goal.currency,
    status: 'completed',
    description: `Savings deposit: ${goal.name}`,
    reference: txnRef,
    metadata: JSON.stringify({ goalId }),
    createdAt: now,
  });

  await db.insert(ledgerEntries).values([
    { id: nanoid(), transactionId: txnId, walletId: wallet.id, entryType: 'debit' as const, amount, balanceAfter: newBalance, createdAt: now },
  ]);

  await db.update(wallets)
    .set({ balance: newBalance, availableBalance: newAvailable, updatedAt: now })
    .where(eq(wallets.id, wallet.id));

  // Credit savings goal
  const newGoalAmount = goal.currentAmount + amount;
  const goalStatus = newGoalAmount >= goal.targetAmount ? 'completed' : 'active';

  await db.update(savingsGoals)
    .set({ currentAmount: newGoalAmount, status: goalStatus as any, updatedAt: now })
    .where(eq(savingsGoals.id, goalId));

  // Savings transaction record
  await db.insert(savingsTransactions).values({
    id: `STXN_${nanoid(14)}`,
    goalId,
    userId,
    type: 'deposit',
    amount,
    balanceAfter: newGoalAmount,
    transactionRef: txnRef,
    createdAt: now,
  });

  // Receipt
  await createReceipt({
    userId,
    vertical: 'savings',
    type: 'savings_deposit',
    amount,
    currency: goal.currency,
    description: `Savings deposit: ${goal.name}`,
    status: 'completed',
    sourceRef: txnRef,
    metadata: { goalId, goalName: goal.name },
  });

  if (goalStatus === 'completed') {
    createNotification({
      userId,
      type: 'transactional',
      title: 'Savings Goal Reached! 🎉',
      body: `You've reached your "${goal.name}" target of ${goal.currency} ${(goal.targetAmount / 100).toLocaleString()}.`,
      deepLink: `apex://savings/goal/${goalId}`,
    });
  }

  return { goalId, deposited: amount, newBalance: newGoalAmount, goalStatus };
}

export async function withdrawFromGoal(
  userId: string,
  goalId: string,
  amount: number,
) {
  const db = getDatabase();
  const [goal] = await db
    .select()
    .from(savingsGoals)
    .where(and(eq(savingsGoals.id, goalId), eq(savingsGoals.userId, userId)))
    .limit(1);

  if (!goal) throw Object.assign(new Error('Savings goal not found'), { statusCode: 404 });
  if (goal.status !== 'active' && goal.status !== 'completed') {
    throw Object.assign(new Error('Cannot withdraw from this goal'), { statusCode: 400 });
  }
  if (goal.locked && goal.deadline && goal.deadline > new Date()) {
    throw Object.assign(new Error('Goal is locked until deadline'), { statusCode: 403 });
  }
  if (goal.currentAmount < amount) {
    throw Object.assign(new Error('Withdrawal exceeds goal balance'), { statusCode: 400 });
  }

  const wallet = await getOrCreateWallet(userId, goal.currency);
  const now = new Date();
  const txnRef = `SAVWD_${nanoid(12)}`;
  const txnId = nanoid();

  // Credit wallet
  const newWalletBalance = wallet.balance + amount;
  const newWalletAvailable = wallet.availableBalance + amount;

  await db.insert(walletTransactions).values({
    id: txnId,
    walletId: wallet.id,
    type: 'fund' as const,
    amount,
    fee: 0,
    currency: goal.currency,
    status: 'completed',
    description: `Savings withdrawal: ${goal.name}`,
    reference: txnRef,
    metadata: JSON.stringify({ goalId }),
    createdAt: now,
  });

  await db.insert(ledgerEntries).values([
    { id: nanoid(), transactionId: txnId, walletId: wallet.id, entryType: 'credit' as const, amount, balanceAfter: newWalletBalance, createdAt: now },
  ]);

  await db.update(wallets)
    .set({ balance: newWalletBalance, availableBalance: newWalletAvailable, updatedAt: now })
    .where(eq(wallets.id, wallet.id));

  // Debit savings goal
  const newGoalAmount = goal.currentAmount - amount;
  const goalStatus = newGoalAmount === 0 ? 'withdrawn' : 'active';

  await db.update(savingsGoals)
    .set({ currentAmount: newGoalAmount, status: goalStatus as any, updatedAt: now })
    .where(eq(savingsGoals.id, goalId));

  // Savings transaction record
  await db.insert(savingsTransactions).values({
    id: `STXN_${nanoid(14)}`,
    goalId,
    userId,
    type: 'withdrawal',
    amount,
    balanceAfter: newGoalAmount,
    transactionRef: txnRef,
    createdAt: now,
  });

  await createReceipt({
    userId,
    vertical: 'savings',
    type: 'savings_withdrawal',
    amount,
    currency: goal.currency,
    description: `Savings withdrawal: ${goal.name}`,
    status: 'completed',
    sourceRef: txnRef,
    metadata: { goalId, goalName: goal.name },
  });

  return { goalId, withdrawn: amount, newBalance: newGoalAmount, goalStatus };
}

export async function cancelGoal(userId: string, goalId: string) {
  const db = getDatabase();
  const [goal] = await db
    .select()
    .from(savingsGoals)
    .where(and(eq(savingsGoals.id, goalId), eq(savingsGoals.userId, userId)))
    .limit(1);

  if (!goal) throw Object.assign(new Error('Savings goal not found'), { statusCode: 404 });
  if (goal.currentAmount > 0) {
    throw Object.assign(new Error('Withdraw funds before cancelling'), { statusCode: 400 });
  }

  await db.update(savingsGoals)
    .set({ status: 'cancelled' as any, updatedAt: new Date() })
    .where(eq(savingsGoals.id, goalId));

  return { goalId, status: 'cancelled' };
}

// =============================================================================
// Ajo/Esusu Groups
// =============================================================================

export async function createAjoGroup(
  userId: string,
  opts: {
    name: string;
    contributionAmount: number;
    currency?: string;
    frequency: 'daily' | 'weekly' | 'biweekly' | 'monthly';
    maxMembers: number;
  },
) {
  const db = getDatabase();
  const now = new Date();
  const id = `AJO_${nanoid(16)}`;
  const inviteCode = nanoid(8).toUpperCase();

  await db.insert(ajoGroups).values({
    id,
    name: opts.name,
    creatorId: userId,
    contributionAmount: opts.contributionAmount,
    currency: opts.currency || 'NGN',
    frequency: opts.frequency,
    maxMembers: opts.maxMembers,
    totalRounds: opts.maxMembers,
    currentRound: 0,
    status: 'forming',
    inviteCode,
    createdAt: now,
    updatedAt: now,
  });

  // Creator is member #1
  const memberId = `AJOM_${nanoid(14)}`;
  await db.insert(ajoMembers).values({
    id: memberId,
    groupId: id,
    userId,
    position: 1,
    status: 'active',
    totalContributed: 0,
    totalReceived: 0,
    joinedAt: now,
  });

  return { id, name: opts.name, inviteCode, maxMembers: opts.maxMembers, memberId };
}

export async function joinAjoGroup(userId: string, inviteCode: string) {
  const db = getDatabase();
  const [group] = await db
    .select()
    .from(ajoGroups)
    .where(eq(ajoGroups.inviteCode, inviteCode))
    .limit(1);

  if (!group) throw Object.assign(new Error('Group not found'), { statusCode: 404 });
  if (group.status !== 'forming') throw Object.assign(new Error('Group is no longer accepting members'), { statusCode: 400 });

  // Check already a member
  const [existing] = await db
    .select()
    .from(ajoMembers)
    .where(and(eq(ajoMembers.groupId, group.id), eq(ajoMembers.userId, userId)))
    .limit(1);
  if (existing) throw Object.assign(new Error('Already a member'), { statusCode: 409 });

  // Count current members
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(ajoMembers)
    .where(eq(ajoMembers.groupId, group.id));

  if (count >= group.maxMembers) {
    throw Object.assign(new Error('Group is full'), { statusCode: 400 });
  }

  const memberId = `AJOM_${nanoid(14)}`;
  const position = count + 1;

  await db.insert(ajoMembers).values({
    id: memberId,
    groupId: group.id,
    userId,
    position,
    status: 'active',
    totalContributed: 0,
    totalReceived: 0,
    joinedAt: new Date(),
  });

  // If full, activate
  if (position === group.maxMembers) {
    const nextPayout = computeNextDeduct(new Date(), group.frequency);
    await db.update(ajoGroups)
      .set({ status: 'active' as any, currentRound: 1, nextPayoutAt: nextPayout, updatedAt: new Date() })
      .where(eq(ajoGroups.id, group.id));

    // Create pending contributions for round 1
    await seedRoundContributions(group.id, 1, group.contributionAmount);

    // Notify all members
    const members = await db.select().from(ajoMembers).where(eq(ajoMembers.groupId, group.id));
    for (const m of members) {
      createNotification({
        userId: m.userId,
        type: 'transactional',
        title: 'Ajo Group Started!',
        body: `"${group.name}" is now active. Round 1 contributions are due.`,
        deepLink: `apex://savings/ajo/${group.id}`,
      });
    }
  }

  return { groupId: group.id, memberId, position, groupName: group.name };
}

export async function getAjoGroup(userId: string, groupId: string) {
  const db = getDatabase();
  const [group] = await db.select().from(ajoGroups).where(eq(ajoGroups.id, groupId)).limit(1);
  if (!group) throw Object.assign(new Error('Group not found'), { statusCode: 404 });

  const members = await db
    .select({
      id: ajoMembers.id,
      userId: ajoMembers.userId,
      position: ajoMembers.position,
      status: ajoMembers.status,
      totalContributed: ajoMembers.totalContributed,
      totalReceived: ajoMembers.totalReceived,
      joinedAt: ajoMembers.joinedAt,
      name: users.firstName,
    })
    .from(ajoMembers)
    .leftJoin(users, eq(ajoMembers.userId, users.id))
    .where(eq(ajoMembers.groupId, groupId))
    .orderBy(ajoMembers.position);

  const contributions = await db
    .select()
    .from(ajoContributions)
    .where(eq(ajoContributions.groupId, groupId))
    .orderBy(desc(ajoContributions.createdAt));

  return { ...group, members, contributions };
}

export async function getUserAjoGroups(userId: string) {
  const db = getDatabase();
  const memberRows = await db
    .select({ groupId: ajoMembers.groupId })
    .from(ajoMembers)
    .where(eq(ajoMembers.userId, userId));

  if (memberRows.length === 0) return [];

  const groupIds = memberRows.map((r) => r.groupId);
  return db
    .select()
    .from(ajoGroups)
    .where(sql`${ajoGroups.id} IN (${sql.join(groupIds.map(id => sql`${id}`), sql`, `)})`)
    .orderBy(desc(ajoGroups.updatedAt));
}

export async function contributeToAjo(userId: string, groupId: string) {
  const db = getDatabase();
  const [group] = await db.select().from(ajoGroups).where(eq(ajoGroups.id, groupId)).limit(1);
  if (!group) throw Object.assign(new Error('Group not found'), { statusCode: 404 });
  if (group.status !== 'active') throw Object.assign(new Error('Group is not active'), { statusCode: 400 });

  const [member] = await db
    .select()
    .from(ajoMembers)
    .where(and(eq(ajoMembers.groupId, groupId), eq(ajoMembers.userId, userId)))
    .limit(1);
  if (!member) throw Object.assign(new Error('Not a member'), { statusCode: 403 });

  // Check pending contribution for current round
  const [contribution] = await db
    .select()
    .from(ajoContributions)
    .where(
      and(
        eq(ajoContributions.groupId, groupId),
        eq(ajoContributions.memberId, member.id),
        eq(ajoContributions.round, group.currentRound),
        eq(ajoContributions.status, 'pending' as any),
      ),
    )
    .limit(1);

  if (!contribution) throw Object.assign(new Error('No pending contribution'), { statusCode: 400 });

  const amount = group.contributionAmount;
  const wallet = await getOrCreateWallet(userId, group.currency);
  if (wallet.availableBalance < amount) {
    throw Object.assign(new Error('Insufficient balance'), { statusCode: 400 });
  }

  const now = new Date();
  const txnRef = `AJOC_${nanoid(12)}`;
  const txnId = nanoid();

  // Debit wallet
  const newBalance = wallet.balance - amount;
  const newAvailable = wallet.availableBalance - amount;

  await db.insert(walletTransactions).values({
    id: txnId,
    walletId: wallet.id,
    type: 'payment' as const,
    amount,
    fee: 0,
    currency: group.currency,
    status: 'completed',
    description: `Ajo contribution: ${group.name} (Round ${group.currentRound})`,
    reference: txnRef,
    metadata: JSON.stringify({ groupId, round: group.currentRound }),
    createdAt: now,
  });

  await db.insert(ledgerEntries).values([
    { id: nanoid(), transactionId: txnId, walletId: wallet.id, entryType: 'debit' as const, amount, balanceAfter: newBalance, createdAt: now },
  ]);

  await db.update(wallets)
    .set({ balance: newBalance, availableBalance: newAvailable, updatedAt: now })
    .where(eq(wallets.id, wallet.id));

  // Mark contribution as paid
  await db.update(ajoContributions)
    .set({ status: 'paid' as any, transactionRef: txnRef, paidAt: now })
    .where(eq(ajoContributions.id, contribution.id));

  // Update member stats
  await db.update(ajoMembers)
    .set({ totalContributed: member.totalContributed + amount })
    .where(eq(ajoMembers.id, member.id));

  // Check if all contributions for this round are paid
  const [{ pending }] = await db
    .select({ pending: sql<number>`count(*)` })
    .from(ajoContributions)
    .where(
      and(
        eq(ajoContributions.groupId, groupId),
        eq(ajoContributions.round, group.currentRound),
        eq(ajoContributions.status, 'pending' as any),
      ),
    );

  if (pending === 0) {
    // All paid — payout to the member whose position matches the round
    await processAjoPayout(group, group.currentRound);
  }

  return { groupId, round: group.currentRound, contributed: amount, txnRef };
}

async function processAjoPayout(group: AjoGroup, round: number) {
  const db = getDatabase();
  const [recipient] = await db
    .select()
    .from(ajoMembers)
    .where(and(eq(ajoMembers.groupId, group.id), eq(ajoMembers.position, round)))
    .limit(1);

  if (!recipient) return;

  const payoutAmount = group.contributionAmount * group.maxMembers;
  const wallet = await getOrCreateWallet(recipient.userId, group.currency);
  const now = new Date();
  const txnRef = `AJOP_${nanoid(12)}`;
  const txnId = nanoid();

  // Credit recipient wallet
  const newBalance = wallet.balance + payoutAmount;
  const newAvailable = wallet.availableBalance + payoutAmount;

  await db.insert(walletTransactions).values({
    id: txnId,
    walletId: wallet.id,
    type: 'fund' as const,
    amount: payoutAmount,
    fee: 0,
    currency: group.currency,
    status: 'completed',
    description: `Ajo payout: ${group.name} (Round ${round})`,
    reference: txnRef,
    metadata: JSON.stringify({ groupId: group.id, round }),
    createdAt: now,
  });

  await db.insert(ledgerEntries).values([
    { id: nanoid(), transactionId: txnId, walletId: wallet.id, entryType: 'credit' as const, amount: payoutAmount, balanceAfter: newBalance, createdAt: now },
  ]);

  await db.update(wallets)
    .set({ balance: newBalance, availableBalance: newAvailable, updatedAt: now })
    .where(eq(wallets.id, wallet.id));

  // Update member received
  await db.update(ajoMembers)
    .set({ totalReceived: recipient.totalReceived + payoutAmount })
    .where(eq(ajoMembers.id, recipient.id));

  // Receipt
  await createReceipt({
    userId: recipient.userId,
    vertical: 'savings',
    type: 'ajo_payout',
    amount: payoutAmount,
    currency: group.currency,
    description: `Ajo payout: ${group.name} (Round ${round})`,
    status: 'completed',
    sourceRef: txnRef,
    metadata: { groupId: group.id, round, groupName: group.name },
  });

  // Notify
  createNotification({
    userId: recipient.userId,
    type: 'transactional',
    title: 'Ajo Payout Received!',
    body: `You received ${group.currency} ${(payoutAmount / 100).toLocaleString()} from "${group.name}" (Round ${round}).`,
    deepLink: `apex://savings/ajo/${group.id}`,
  });

  // Advance round or complete
  if (round >= group.totalRounds) {
    await db.update(ajoGroups)
      .set({ status: 'completed' as any, updatedAt: now })
      .where(eq(ajoGroups.id, group.id));
  } else {
    const nextPayout = computeNextDeduct(now, group.frequency);
    await db.update(ajoGroups)
      .set({ currentRound: round + 1, nextPayoutAt: nextPayout, updatedAt: now })
      .where(eq(ajoGroups.id, group.id));

    // Seed contributions for next round
    await seedRoundContributions(group.id, round + 1, group.contributionAmount);
  }
}

async function seedRoundContributions(groupId: string, round: number, amount: number) {
  const db = getDatabase();
  const members = await db.select().from(ajoMembers).where(eq(ajoMembers.groupId, groupId));
  const now = new Date();

  for (const member of members) {
    await db.insert(ajoContributions).values({
      id: `AJOCT_${nanoid(13)}`,
      groupId,
      memberId: member.id,
      round,
      amount,
      status: 'pending',
      createdAt: now,
    });
  }
}

// =============================================================================
// Auto-deduction processor (called by scheduler)
// =============================================================================

export async function processAutoDeductions() {
  const db = getDatabase();
  const now = new Date();

  const due = await db
    .select()
    .from(savingsGoals)
    .where(
      and(
        eq(savingsGoals.status, 'active' as any),
        lte(savingsGoals.nextDeductAt, now),
      ),
    );

  const results = [];
  for (const goal of due) {
    if (!goal.autoDeductAmount) continue;
    try {
      const result = await depositToGoal(goal.userId, goal.id, goal.autoDeductAmount);
      // Update next deduction time
      const next = computeNextDeduct(now, goal.autoDeductFrequency as any);
      await db.update(savingsGoals)
        .set({ nextDeductAt: next, updatedAt: now })
        .where(eq(savingsGoals.id, goal.id));
      results.push({ goalId: goal.id, status: 'success', deposited: result.deposited, newBalance: result.newBalance });
    } catch (err: any) {
      results.push({ goalId: goal.id, status: 'failed', error: err.message });
    }
  }

  return results;
}

// =============================================================================
// Helpers
// =============================================================================

function computeNextDeduct(from: Date, frequency: string): Date {
  const d = new Date(from);
  switch (frequency) {
    case 'daily': d.setDate(d.getDate() + 1); break;
    case 'weekly': d.setDate(d.getDate() + 7); break;
    case 'biweekly': d.setDate(d.getDate() + 14); break;
    case 'monthly': d.setMonth(d.getMonth() + 1); break;
  }
  return d;
}

import crypto from "crypto";
import { readFile, writeFile, withRetry } from "./github";

const POOL_PATH = "invites/pool.json";
const INVITES_PATH = "invites/invites.json";
const USERS_PATH = "invites/users.json";

// Characters without I, O, L, 0, 1 to avoid confusion
const INVITE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ2345678";

export const ADMIN_GOOGLE_ID = "108184212392053966337";
const CODES_PER_USER = 3;

interface PoolData {
  pool: string[];
}

export interface InviteData {
  code: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  usedBy: string | null;
  usedByName: string | null;
  usedAt: string | null;
}

interface InvitesData {
  invites: InviteData[];
}

export interface BanData {
  type: "temporary" | "permanent";
  until?: string;
  reason: string;
}

export interface UserData {
  googleId: string;
  displayName: string;
  nickname?: string;
  email: string;
  photoUrl: string;
  invitedBy: string;
  invitesRemaining: number;
  isAdmin: boolean;
  registeredAt: string;
  ban?: BanData | null;
}

interface UsersData {
  users: UserData[];
}

function randomChars(n: number): string {
  let result = "";
  const bytes = crypto.randomBytes(n);
  for (let i = 0; i < n; i++) {
    result += INVITE_CHARS[bytes[i] % INVITE_CHARS.length];
  }
  return result;
}

function generateCode(): string {
  return `1UP-${randomChars(4)}-${randomChars(4)}`;
}

/**
 * Generate N codes and add to pool.json
 * Returns number of codes actually added.
 */
export async function generatePool(quantity: number): Promise<number> {
  return await withRetry(async () => {
    const poolFile = await readFile<PoolData>(POOL_PATH);
    const existingSet = new Set(poolFile.parsed.pool);

    // Also read invites.json to avoid collisions with assigned codes
    let assignedCodes = new Set<string>();
    try {
      const invitesFile = await readFile<InvitesData>(INVITES_PATH);
      assignedCodes = new Set(invitesFile.parsed.invites.map((i) => i.code));
    } catch {}

    const newCodes: string[] = [];
    let attempts = 0;
    while (newCodes.length < quantity && attempts < quantity * 3) {
      const code = generateCode();
      if (!existingSet.has(code) && !assignedCodes.has(code)) {
        newCodes.push(code);
        existingSet.add(code);
      }
      attempts++;
    }

    poolFile.parsed.pool.push(...newCodes);

    await writeFile(
      POOL_PATH,
      poolFile.parsed,
      poolFile.sha,
      `Pool: +${newCodes.length} codes (total: ${poolFile.parsed.pool.length})`
    );

    console.log(`Pool generated: ${newCodes.length} codes`);
    return newCodes.length;
  });
}

/**
 * Get current pool size
 */
export async function getPoolSize(): Promise<number> {
  const { parsed } = await readFile<PoolData>(POOL_PATH);
  return parsed.pool.length;
}

/**
 * Assign 3 codes from pool to a new user.
 * Creates entries in invites.json and users.json.
 * Returns the assigned codes, or empty array if pool is empty.
 */
export async function assignCodesToNewUser(
  googleId: string,
  displayName: string,
  email: string,
  photoUrl: string,
  invitedByCode: string
): Promise<string[]> {
  return await withRetry(async () => {
    // Read pool
    const poolFile = await readFile<PoolData>(POOL_PATH);
    if (poolFile.parsed.pool.length === 0) {
      console.log("Pool is empty, no codes to assign");
      return [];
    }

    // Take up to CODES_PER_USER from pool
    const taken = poolFile.parsed.pool.splice(0, CODES_PER_USER);

    // Save updated pool
    await writeFile(
      POOL_PATH,
      poolFile.parsed,
      poolFile.sha,
      `Pool: assigned ${taken.length} to ${displayName}`
    );

    // Add invite entries
    await withRetry(async () => {
      const invitesFile = await readFile<InvitesData>(INVITES_PATH);

      for (const code of taken) {
        invitesFile.parsed.invites.push({
          code,
          createdBy: googleId,
          createdByName: displayName,
          createdAt: new Date().toISOString(),
          usedBy: null,
          usedByName: null,
          usedAt: null,
        });
      }

      await writeFile(
        INVITES_PATH,
        invitesFile.parsed,
        invitesFile.sha,
        `Invites assigned to ${displayName}`
      );
    });

    // Add user entry
    await withRetry(async () => {
      const usersFile = await readFile<UsersData>(USERS_PATH);

      // Skip if already exists
      if (usersFile.parsed.users.some((u) => u.googleId === googleId)) return;

      usersFile.parsed.users.push({
        googleId,
        displayName,
        email: email || "",
        photoUrl: photoUrl || "",
        invitedBy: invitedByCode,
        invitesRemaining: taken.length,
        isAdmin: false,
        registeredAt: new Date().toISOString(),
      });

      await writeFile(
        USERS_PATH,
        usersFile.parsed,
        usersFile.sha,
        `New user: ${displayName}`
      );
    });

    console.log(`Assigned ${taken.length} codes to ${displayName}: ${taken.join(", ")}`);
    return taken;
  });
}

/**
 * Check if a user exists in users.json
 */
export async function findUser(googleId: string): Promise<UserData | null> {
  try {
    const { parsed } = await readFile<UsersData>(USERS_PATH);
    return parsed.users.find((u) => u.googleId === googleId) || null;
  } catch {
    return null;
  }
}

/**
 * Get invites belonging to a user
 */
export async function getUserInvites(googleId: string): Promise<InviteData[]> {
  try {
    const { parsed } = await readFile<InvitesData>(INVITES_PATH);
    return parsed.invites.filter((i) => i.createdBy === googleId);
  } catch {
    return [];
  }
}

/**
 * Mark an invite as used when someone redeems it
 */
export async function markInviteUsed(
  code: string,
  usedByGoogleId: string,
  usedByName: string
): Promise<boolean> {
  return await withRetry(async () => {
    const invitesFile = await readFile<InvitesData>(INVITES_PATH);
    const invite = invitesFile.parsed.invites.find(
      (i) => i.code === code.toUpperCase().trim() && i.usedBy === null
    );
    if (!invite) return false;

    invite.usedBy = usedByGoogleId;
    invite.usedByName = usedByName;
    invite.usedAt = new Date().toISOString();

    await writeFile(
      INVITES_PATH,
      invitesFile.parsed,
      invitesFile.sha,
      `Invite ${code} used by ${usedByName}`
    );
    return true;
  });
}

/**
 * Validate an invite code (exists and not used)
 */
export async function validateInvite(code: string): Promise<{ valid: boolean; createdByName?: string }> {
  try {
    const { parsed } = await readFile<InvitesData>(INVITES_PATH);
    const invite = parsed.invites.find(
      (i) => i.code === code.toUpperCase().trim() && i.usedBy === null
    );
    if (!invite) return { valid: false };
    return { valid: true, createdByName: invite.createdByName };
  } catch {
    return { valid: false };
  }
}

/**
 * Give extra invite codes to an existing user from the pool.
 * Returns the codes assigned, or empty array if pool is empty.
 */
export async function addInvitesToUser(
  googleId: string,
  quantity: number
): Promise<string[]> {
  return await withRetry(async () => {
    // Read pool
    const poolFile = await readFile<PoolData>(POOL_PATH);
    if (poolFile.parsed.pool.length === 0) {
      return [];
    }

    // Read user to get displayName
    const usersFile = await readFile<UsersData>(USERS_PATH);
    const user = usersFile.parsed.users.find((u) => u.googleId === googleId);
    if (!user) throw new Error("User not found");

    // Take codes from pool
    const taken = poolFile.parsed.pool.splice(0, Math.min(quantity, poolFile.parsed.pool.length));

    await writeFile(
      POOL_PATH,
      poolFile.parsed,
      poolFile.sha,
      `Pool: +${taken.length} extras to ${user.displayName}`
    );

    // Add invite entries
    await withRetry(async () => {
      const invitesFile = await readFile<InvitesData>(INVITES_PATH);

      for (const code of taken) {
        invitesFile.parsed.invites.push({
          code,
          createdBy: googleId,
          createdByName: user.displayName,
          createdAt: new Date().toISOString(),
          usedBy: null,
          usedByName: null,
          usedAt: null,
        });
      }

      await writeFile(
        INVITES_PATH,
        invitesFile.parsed,
        invitesFile.sha,
        `+${taken.length} extra invites for ${user.displayName}`
      );
    });

    // Update user's invitesRemaining
    await withRetry(async () => {
      const uf = await readFile<UsersData>(USERS_PATH);
      const u = uf.parsed.users.find((u) => u.googleId === googleId);
      if (u) {
        u.invitesRemaining = (u.invitesRemaining || 0) + taken.length;
      }
      await writeFile(USERS_PATH, uf.parsed, uf.sha, `Updated invites for ${user.displayName}`);
    });

    console.log(`Added ${taken.length} extra codes to ${user.displayName}: ${taken.join(", ")}`);
    return taken;
  });
}

// --- Admin dashboard functions ---

export interface AdminStats {
  totalUsers: number;
  invitesUsed: number;
  poolSize: number;
  invitesWithUsers: number;
}

export async function getStats(): Promise<AdminStats> {
  const [usersFile, invitesFile, poolFile] = await Promise.all([
    readFile<UsersData>(USERS_PATH),
    readFile<InvitesData>(INVITES_PATH),
    readFile<PoolData>(POOL_PATH),
  ]);

  const used = invitesFile.parsed.invites.filter((i) => i.usedBy !== null).length;
  const available = invitesFile.parsed.invites.filter((i) => i.usedBy === null).length;

  return {
    totalUsers: usersFile.parsed.users.length,
    invitesUsed: used,
    poolSize: poolFile.parsed.pool.length,
    invitesWithUsers: available,
  };
}

export async function getAllUsers(): Promise<UserData[]> {
  const { parsed } = await readFile<UsersData>(USERS_PATH);
  return parsed.users;
}

export async function getAllInvites(): Promise<InviteData[]> {
  const { parsed } = await readFile<InvitesData>(INVITES_PATH);
  return parsed.invites;
}

export async function revokeUser(googleId: string): Promise<boolean> {
  return await withRetry(async () => {
    const usersFile = await readFile<UsersData>(USERS_PATH);
    const idx = usersFile.parsed.users.findIndex((u) => u.googleId === googleId);
    if (idx === -1) return false;

    const userName = usersFile.parsed.users[idx].displayName;
    usersFile.parsed.users.splice(idx, 1);

    await writeFile(
      USERS_PATH,
      usersFile.parsed,
      usersFile.sha,
      `Revoked: ${userName}`
    );

    console.log(`User revoked: ${userName} (${googleId})`);
    return true;
  });
}

export async function invalidateInvite(code: string): Promise<boolean> {
  return await withRetry(async () => {
    const invitesFile = await readFile<InvitesData>(INVITES_PATH);
    const idx = invitesFile.parsed.invites.findIndex(
      (i) => i.code === code && i.usedBy === null
    );
    if (idx === -1) return false;

    invitesFile.parsed.invites.splice(idx, 1);

    await writeFile(
      INVITES_PATH,
      invitesFile.parsed,
      invitesFile.sha,
      `Invite invalidated: ${code}`
    );

    console.log(`Invite invalidated: ${code}`);
    return true;
  });
}

// --- Ban/Unban ---

export async function banUser(
  googleId: string,
  type: "temporary" | "permanent",
  days?: number
): Promise<boolean> {
  return await withRetry(async () => {
    const usersFile = await readFile<UsersData>(USERS_PATH);
    const user = usersFile.parsed.users.find((u) => u.googleId === googleId);
    if (!user) return false;

    const ban: BanData = { type, reason: "admin action" };
    if (type === "temporary" && days) {
      const until = new Date();
      until.setDate(until.getDate() + days);
      ban.until = until.toISOString();
    }
    user.ban = ban;

    await writeFile(
      USERS_PATH,
      usersFile.parsed,
      usersFile.sha,
      `Ban ${type}: ${user.displayName}${days ? ` (${days}d)` : ""}`
    );

    console.log(`User banned: ${user.displayName} (${type}${days ? `, ${days}d` : ""})`);
    return true;
  });
}

export async function unbanUser(googleId: string): Promise<boolean> {
  return await withRetry(async () => {
    const usersFile = await readFile<UsersData>(USERS_PATH);
    const user = usersFile.parsed.users.find((u) => u.googleId === googleId);
    if (!user || !user.ban) return false;

    const userName = user.displayName;
    user.ban = null;

    await writeFile(
      USERS_PATH,
      usersFile.parsed,
      usersFile.sha,
      `Unbanned: ${userName}`
    );

    console.log(`User unbanned: ${userName}`);
    return true;
  });
}

// --- Admin action log ---

const LOG_PATH = "invites/admin-log.json";

export interface AdminLogEntry {
  timestamp: string;
  action: string;
  target: string;
  targetId: string;
  details: string;
  admin: string;
}

interface AdminLogData {
  logs: AdminLogEntry[];
}

export async function addAdminLog(
  action: string,
  target: string,
  targetId: string,
  details: string
): Promise<void> {
  try {
    await withRetry(async () => {
      let logFile: { parsed: AdminLogData; sha: string };
      try {
        logFile = await readFile<AdminLogData>(LOG_PATH);
      } catch {
        // File doesn't exist yet — create it
        logFile = { parsed: { logs: [] }, sha: "" };
      }

      logFile.parsed.logs.unshift({
        timestamp: new Date().toISOString(),
        action,
        target,
        targetId,
        details,
        admin: "stories english",
      });

      // Keep max 500 entries
      if (logFile.parsed.logs.length > 500) {
        logFile.parsed.logs = logFile.parsed.logs.slice(0, 500);
      }

      if (logFile.sha) {
        await writeFile(LOG_PATH, logFile.parsed, logFile.sha, `Log: ${action} - ${target}`);
      } else {
        // Create the file for the first time
        const res = await fetch(
          `https://api.github.com/repos/${process.env.GITHUB_REPO || "storiehistoria/-1up-station-data"}/contents/${LOG_PATH}`,
          {
            method: "PUT",
            headers: {
              Authorization: `token ${process.env.GITHUB_TOKEN || ""}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              message: `Log: ${action} - ${target}`,
              content: Buffer.from(JSON.stringify(logFile.parsed, null, 2)).toString("base64"),
            }),
          }
        );
        if (!res.ok) throw new Error(`Create log failed: ${res.status}`);
      }
    });
  } catch (err) {
    console.error("Failed to write admin log:", err);
  }
}

export async function getAdminLogs(limit = 50): Promise<AdminLogEntry[]> {
  try {
    const { parsed } = await readFile<AdminLogData>(LOG_PATH);
    return parsed.logs.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Update a user's nickname in users.json
 */
export async function updateNickname(googleId: string, nickname: string): Promise<boolean> {
  return await withRetry(async () => {
    const usersFile = await readFile<UsersData>(USERS_PATH);
    const user = usersFile.parsed.users.find((u) => u.googleId === googleId);
    if (!user) return false;

    user.nickname = nickname;

    await writeFile(
      USERS_PATH,
      usersFile.parsed,
      usersFile.sha,
      `Nickname: ${user.displayName} -> ${nickname}`
    );

    console.log(`Nickname updated: ${user.displayName} -> ${nickname}`);
    return true;
  });
}

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

export interface UserData {
  googleId: string;
  displayName: string;
  email: string;
  photoUrl: string;
  invitedBy: string;
  invitesRemaining: number;
  isAdmin: boolean;
  registeredAt: string;
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

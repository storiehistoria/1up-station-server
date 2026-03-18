import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import express from "express";
import cors from "cors";
import http from "http";
import path from "path";
import { LobbyRoom } from "./rooms/LobbyRoom";
import {
  ADMIN_GOOGLE_ID,
  generatePool,
  getPoolSize,
  getUserInvites,
  validateInvite,
  markInviteUsed,
  findUser,
  getStats,
  getAllUsers,
  getAllInvites,
  revokeUser,
  invalidateInvite,
} from "./services/InvitePool";

const port = Number(process.env.PORT) || 2567;
const GOOGLE_CLIENT_ID = "89999411836-mi24elqjnuofqfh24qg5rvnld8o5vqic.apps.googleusercontent.com";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// --- Admin auth middleware (verifies Google ID token) ---

async function verifyGoogleToken(idToken: string): Promise<string | null> {
  try {
    // Decode JWT payload (base64url) without crypto verification
    // The token comes from Google's trusted JS library
    const parts = idToken.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));

    // Check audience matches our client ID
    if (payload.aud !== GOOGLE_CLIENT_ID) return null;

    // Check token hasn't expired
    if (payload.exp && payload.exp < Date.now() / 1000) return null;

    return payload.sub || null; // sub = Google ID
  } catch {
    return null;
  }
}

async function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  // Support both x-google-id header (curl/testing) and Authorization Bearer token (dashboard)
  const authHeader = req.headers.authorization;
  let googleId = req.headers["x-google-id"] as string | undefined;

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    googleId = (await verifyGoogleToken(token)) || undefined;
  }

  if (googleId !== ADMIN_GOOGLE_ID) {
    res.status(403).json({ error: "Acesso negado" });
    return;
  }
  next();
}

// --- Admin dashboard ---

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "admin", "dashboard.html"));
});

// --- Admin API routes ---

app.get("/admin/api/stats", requireAdmin, async (_req, res) => {
  try {
    const stats = await getStats();
    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/api/users", requireAdmin, async (_req, res) => {
  try {
    const users = await getAllUsers();
    res.json({ users });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/api/invites", requireAdmin, async (_req, res) => {
  try {
    const invites = await getAllInvites();
    res.json({ invites });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/api/pool/generate", requireAdmin, async (req, res) => {
  try {
    const quantidade = Number(req.body.quantidade) || 100;
    const generated = await generatePool(quantidade);
    const poolSize = await getPoolSize();
    res.json({ generated, poolSize });
  } catch (err: any) {
    console.error("Pool generate failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/api/users/:id/revoke", requireAdmin, async (req, res) => {
  try {
    const success = await revokeUser(req.params.id as string);
    res.json({ success });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/api/invites/:code/invalidate", requireAdmin, async (req, res) => {
  try {
    const success = await invalidateInvite(req.params.code as string);
    res.json({ success });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Keep old admin routes for backward compat (curl with x-google-id)
app.post("/admin/pool/generate", requireAdmin, async (req, res) => {
  try {
    const quantidade = Number(req.body.quantidade) || 100;
    const generated = await generatePool(quantidade);
    const poolSize = await getPoolSize();
    res.json({ generated, poolSize });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/pool/size", requireAdmin, async (_req, res) => {
  try {
    const poolSize = await getPoolSize();
    res.json({ poolSize });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- Invite routes (for Electron app) ---

app.post("/api/invites/validate", async (req, res) => {
  try {
    const result = await validateInvite(req.body.code);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ valid: false, reason: err.message });
  }
});

app.post("/api/invites/redeem", async (req, res) => {
  try {
    const { code, googleId, displayName } = req.body;
    const success = await markInviteUsed(code, googleId, displayName);
    res.json({ success });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/invites/:googleId", async (req, res) => {
  try {
    const invites = await getUserInvites(req.params.googleId);
    res.json({ invites });
  } catch (err: any) {
    res.status(500).json({ invites: [] });
  }
});

app.get("/api/user/:googleId", async (req, res) => {
  try {
    const user = await findUser(req.params.googleId);
    res.json({ user });
  } catch (err: any) {
    res.status(500).json({ user: null });
  }
});

const httpServer = http.createServer(app);

const server = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

server.define("lobby", LobbyRoom);

server.listen(port).then(() => {
  console.log(`1UP Station server listening on port ${port}`);
});

import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import express from "express";
import cors from "cors";
import http from "http";
import { LobbyRoom } from "./rooms/LobbyRoom";
import {
  ADMIN_GOOGLE_ID,
  generatePool,
  getPoolSize,
  getUserInvites,
  validateInvite,
  markInviteUsed,
  findUser,
} from "./services/InvitePool";

const port = Number(process.env.PORT) || 2567;

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// --- Admin routes ---

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const googleId = req.headers["x-google-id"] as string;
  if (googleId !== ADMIN_GOOGLE_ID) {
    res.status(403).json({ error: "Acesso negado" });
    return;
  }
  next();
}

app.post("/admin/pool/generate", requireAdmin, async (req, res) => {
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

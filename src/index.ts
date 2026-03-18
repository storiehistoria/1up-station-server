import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import express from "express";
import cors from "cors";
import crypto from "crypto";
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
  addInvitesToUser,
  banUser,
  unbanUser,
  addAdminLog,
  getAdminLogs,
  updateNickname,
} from "./services/InvitePool";

const port = Number(process.env.PORT) || 2567;

// Admin OAuth config (env vars set on Render)
const ADMIN_CLIENT_ID = process.env.ADMIN_GOOGLE_CLIENT_ID || "";
const ADMIN_CLIENT_SECRET = process.env.ADMIN_GOOGLE_CLIENT_SECRET || "";
const COOKIE_SECRET = process.env.COOKIE_SECRET || crypto.randomBytes(32).toString("hex");

const app = express();
app.use(cors());
app.use(express.json());

// --- Cookie helpers ---

function signCookie(value: string): string {
  const sig = crypto.createHmac("sha256", COOKIE_SECRET).update(value).digest("hex");
  return `${value}.${sig}`;
}

function verifyCookie(signed: string): string | null {
  const dot = signed.lastIndexOf(".");
  if (dot === -1) return null;
  const value = signed.slice(0, dot);
  const sig = signed.slice(dot + 1);
  const expected = crypto.createHmac("sha256", COOKIE_SECRET).update(value).digest("hex");
  if (sig !== expected) return null;
  return value;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  header.split(";").forEach((pair) => {
    const [key, ...rest] = pair.trim().split("=");
    if (key) cookies[key] = decodeURIComponent(rest.join("="));
  });
  return cookies;
}

// --- Health ---

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// --- Debug (temporary) ---
app.get("/admin/debug", (_req, res) => {
  const cid = process.env.ADMIN_GOOGLE_CLIENT_ID || "(not set)";
  const secret = process.env.ADMIN_GOOGLE_CLIENT_SECRET ? "set" : "(not set)";
  res.json({
    clientId: cid.slice(0, 20) + "...",
    secretSet: secret,
    cookieSecretSet: COOKIE_SECRET ? "set" : "(not set)",
  });
});

// --- Admin OAuth flow ---

function getCallbackUrl(req: express.Request): string {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  return `${proto}://${host}/admin/auth/callback`;
}

app.get("/admin/auth/login", (req, res) => {
  const callbackUrl = getCallbackUrl(req);
  const params = new URLSearchParams({
    client_id: ADMIN_CLIENT_ID,
    redirect_uri: callbackUrl,
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get("/admin/auth/callback", async (req, res) => {
  const code = req.query.code as string;
  if (!code) {
    res.status(400).send("Missing code");
    return;
  }

  try {
    const callbackUrl = getCallbackUrl(req);

    // Exchange code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: ADMIN_CLIENT_ID,
        client_secret: ADMIN_CLIENT_SECRET,
        redirect_uri: callbackUrl,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error("Token exchange failed:", err);
      res.status(500).send("Login failed");
      return;
    }

    const tokens: any = await tokenRes.json();

    // Decode ID token to get Google ID
    const parts = tokens.id_token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    const googleId = payload.sub;

    if (googleId !== ADMIN_GOOGLE_ID) {
      res.send(`
        <html><body style="background:#0a0a0f;color:#ff4444;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column">
          <h1>Acesso negado</h1>
          <p style="color:#888;margin-top:12px">Apenas o admin pode acessar esta pagina.</p>
          <a href="/admin" style="color:#7c6aff;margin-top:20px">Voltar</a>
        </body></html>
      `);
      return;
    }

    // Set signed session cookie
    const signed = signCookie(googleId);
    res.setHeader("Set-Cookie", `admin_session=${signed}; HttpOnly; Path=/admin; SameSite=Lax; Max-Age=86400`);

    // Store user info in a separate cookie for the frontend
    const userInfo = Buffer.from(JSON.stringify({
      name: payload.name || payload.email,
      picture: payload.picture || "",
    })).toString("base64");
    res.setHeader("Set-Cookie", [
      `admin_session=${signed}; HttpOnly; Path=/admin; SameSite=Lax; Max-Age=86400`,
      `admin_user=${userInfo}; Path=/admin; SameSite=Lax; Max-Age=86400`,
    ]);

    res.redirect("/admin");
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send("Login failed");
  }
});

app.get("/admin/auth/logout", (_req, res) => {
  res.setHeader("Set-Cookie", [
    "admin_session=; HttpOnly; Path=/admin; Max-Age=0",
    "admin_user=; Path=/admin; Max-Age=0",
  ]);
  res.redirect("/admin");
});

// --- Admin auth middleware ---

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  // Support x-google-id header for curl/testing
  const headerGoogleId = req.headers["x-google-id"] as string | undefined;
  if (headerGoogleId === ADMIN_GOOGLE_ID) {
    next();
    return;
  }

  // Check signed session cookie
  const cookies = parseCookies(req.headers.cookie);
  const session = cookies.admin_session;
  if (session) {
    const googleId = verifyCookie(session);
    if (googleId === ADMIN_GOOGLE_ID) {
      next();
      return;
    }
  }

  res.status(403).json({ error: "Acesso negado" });
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
    await addAdminLog("pool_generate", "Pool", "", `${generated} codigos gerados`);
    res.json({ generated, poolSize });
  } catch (err: any) {
    console.error("Pool generate failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/api/users/:id/add-invites", requireAdmin, async (req, res) => {
  try {
    const googleId = req.params.id as string;
    const quantidade = Number(req.body.quantidade) || 3;
    const codes = await addInvitesToUser(googleId, quantidade);
    const user = await findUser(googleId);
    await addAdminLog("add_invites", user?.displayName || googleId, googleId, `+${codes.length} convites`);
    res.json({ success: true, added: codes.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/api/users/:id/revoke", requireAdmin, async (req, res) => {
  try {
    const googleId = req.params.id as string;
    const user = await findUser(googleId);
    const success = await revokeUser(googleId);
    if (success) await addAdminLog("revoke", user?.displayName || googleId, googleId, "Revogado");
    res.json({ success });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/api/invites/:code/invalidate", requireAdmin, async (req, res) => {
  try {
    const code = req.params.code as string;
    const success = await invalidateInvite(code);
    if (success) await addAdminLog("invalidate_invite", code, "", "Convite invalidado");
    res.json({ success });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- Ban/Unban routes ---

app.post("/admin/api/users/:id/ban", requireAdmin, async (req, res) => {
  try {
    const googleId = req.params.id as string;
    const { type, days } = req.body;
    const user = await findUser(googleId);
    const success = await banUser(googleId, type, days);
    if (success) {
      const details = type === "temporary" ? `${days} dias` : "Permanente";
      await addAdminLog(`ban_${type}`, user?.displayName || googleId, googleId, details);
    }
    res.json({ success });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/api/users/:id/unban", requireAdmin, async (req, res) => {
  try {
    const googleId = req.params.id as string;
    const user = await findUser(googleId);
    const success = await unbanUser(googleId);
    if (success) await addAdminLog("unban", user?.displayName || googleId, googleId, "Desbanido");
    res.json({ success });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- Admin logs route ---

app.get("/admin/api/logs", requireAdmin, async (_req, res) => {
  try {
    const logs = await getAdminLogs(50);
    res.json({ logs });
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

app.post("/api/user/:googleId/nickname", async (req, res) => {
  try {
    const googleId = req.params.googleId as string;
    const nickname = (req.body.nickname || "").trim().slice(0, 20);
    if (nickname.length < 2) {
      res.status(400).json({ error: "Nickname deve ter no minimo 2 caracteres" });
      return;
    }
    const success = await updateNickname(googleId, nickname);
    res.json({ success });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/user/:googleId/nickname", async (req, res) => {
  try {
    const googleId = req.params.googleId as string;
    const { nickname } = req.body;
    if (!nickname || typeof nickname !== "string" || nickname.trim().length < 2 || nickname.trim().length > 20) {
      res.status(400).json({ success: false, error: "Nickname deve ter entre 2 e 20 caracteres" });
      return;
    }
    const clean = nickname.trim().replace(/[^a-zA-Z0-9\u00C0-\u024F\s_-]/g, "").trim();
    if (clean.length < 2) {
      res.status(400).json({ success: false, error: "Nickname invalido" });
      return;
    }
    const success = await updateNickname(googleId, clean);
    res.json({ success });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
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

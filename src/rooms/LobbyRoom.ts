import { Room, Client } from "colyseus";
import { LobbyState } from "../schemas/LobbyState";
import { PlayerState, Presence } from "../schemas/PlayerState";
import { Invite } from "../schemas/Invite";
import { findUser, assignCodesToNewUser, ADMIN_GOOGLE_ID } from "../services/InvitePool";

const MAX_CHAT_HISTORY = 50;

interface ChatMsg {
  id: string;
  senderId: string;
  senderNickname: string;
  senderPhoto: string;
  text: string;
  timestamp: number;
  type: "user" | "system";
}

let msgCounter = 0;
function generateMsgId(): string {
  return `msg_${Date.now()}_${++msgCounter}`;
}

let inviteCounter = 0;
function generateInviteId(): string {
  return `inv_${Date.now()}_${++inviteCounter}`;
}

export class LobbyRoom extends Room<LobbyState> {
  private chatHistory: ChatMsg[] = [];

  onCreate() {
    this.state = new LobbyState();
    this.maxClients = 100;

    this.onMessage("chat", (client, data: { text: string }) => {
      this.handleChat(client, data.text);
    });

    this.onMessage("setNickname", (client, data: { nickname: string }) => {
      this.handleSetNickname(client, data.nickname);
    });

    this.onMessage("setPresence", (client, data: { presence: Presence }) => {
      this.handleSetPresence(client, data.presence);
    });

    this.onMessage("invite", (client, data: { toSessionId: string }) => {
      this.handleInvite(client, data.toSessionId);
    });

    this.onMessage("inviteResponse", (client, data: { inviteId: string; accept: boolean }) => {
      this.handleInviteResponse(client, data.inviteId, data.accept);
    });

    console.log("LobbyRoom created");
  }

  async onJoin(client: Client, options: { nickname?: string; googleId?: string; displayName?: string; photoUrl?: string; email?: string }) {
    const googleId = options.googleId;

    // Reject if no googleId
    if (!googleId) {
      client.leave();
      return;
    }

    // Check if user is banned
    const userData = await findUser(googleId);
    if (userData?.ban) {
      if (userData.ban.type === "permanent") {
        client.send("banned", { message: "Seu acesso foi revogado." });
        client.leave();
        return;
      }
      if (userData.ban.type === "temporary" && userData.ban.until) {
        const until = new Date(userData.ban.until);
        if (until > new Date()) {
          const dateStr = until.toLocaleDateString("pt-BR");
          client.send("banned", { message: `Seu acesso foi suspenso ate ${dateStr}.` });
          client.leave();
          return;
        }
      }
    }

    // Unique session: disconnect previous login with same googleId
    const toRemove: string[] = [];
    this.state.players.forEach((existingPlayer, sessionId) => {
      if (existingPlayer.googleId === googleId && sessionId !== client.sessionId) {
        toRemove.push(sessionId);
      }
    });
    for (const sessionId of toRemove) {
      this.state.players.delete(sessionId);
      const oldClient = this.clients.find((c) => c.sessionId === sessionId);
      if (oldClient) {
        oldClient.send("kicked", { reason: "Outra sessao foi iniciada" });
        oldClient.leave();
      }
    }

    const displayName = (options.displayName || options.nickname || "Jogador").substring(0, 50);

    const player = new PlayerState();
    player.sessionId = client.sessionId;
    player.googleId = googleId;
    player.nickname = displayName;
    player.photoUrl = options.photoUrl || "";
    player.presence = "online";
    player.joinedAt = Date.now();

    this.state.players.set(client.sessionId, player);
    console.log(`${displayName} joined the lobby`);

    // System message: player joined (add to history + broadcast to others)
    this.broadcastSystemMessage(`${displayName} entrou no lobby`, client);

    // Send chat history to the new client (already includes the join message)
    client.send("chatHistory", this.chatHistory);

    // Assign pool codes to new users (async, don't block join)
    if (googleId !== ADMIN_GOOGLE_ID) {
      this.assignPoolCodes(googleId, displayName, options.email || "", options.photoUrl || "").catch((err) => {
        console.error(`Failed to assign pool codes to ${displayName}:`, err);
      });
    }
  }

  private async assignPoolCodes(googleId: string, displayName: string, email: string, photoUrl: string) {
    const existing = await findUser(googleId);
    if (existing) return;

    const codes = await assignCodesToNewUser(googleId, displayName, email, photoUrl, "POOL");
    if (codes.length > 0) {
      console.log(`Assigned ${codes.length} pool codes to ${displayName}`);
    }
  }

  onLeave(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) {
      console.log(`${player.nickname} left the lobby`);
      // System message: player left
      this.broadcastSystemMessage(`${player.nickname} saiu do lobby`);
    }
    this.state.players.delete(client.sessionId);

    // Clean up invites involving this player
    const invitesToRemove: string[] = [];
    this.state.invites.forEach((invite: Invite, key: string) => {
      if (invite.fromSessionId === client.sessionId || invite.toSessionId === client.sessionId) {
        invitesToRemove.push(key);
      }
    });
    for (const key of invitesToRemove) {
      this.state.invites.delete(key);
    }
  }

  private handleChat(client: Client, text: string) {
    const player = this.state.players.get(client.sessionId);
    if (!player || !text?.trim()) return;

    const sanitized = text.trim().slice(0, 200);

    const msg: ChatMsg = {
      id: generateMsgId(),
      senderId: player.googleId,
      senderNickname: player.nickname,
      senderPhoto: player.photoUrl,
      text: sanitized,
      timestamp: Date.now(),
      type: "user",
    };

    this.chatHistory.push(msg);
    if (this.chatHistory.length > MAX_CHAT_HISTORY) {
      this.chatHistory.shift();
    }

    this.broadcast("chat", msg);
  }

  private broadcastSystemMessage(text: string, except?: Client) {
    const msg: ChatMsg = {
      id: generateMsgId(),
      senderId: "system",
      senderNickname: "sistema",
      senderPhoto: "",
      text,
      timestamp: Date.now(),
      type: "system",
    };

    this.chatHistory.push(msg);
    if (this.chatHistory.length > MAX_CHAT_HISTORY) {
      this.chatHistory.shift();
    }

    if (except) {
      this.broadcast("chat", msg, { except });
    } else {
      this.broadcast("chat", msg);
    }
  }

  private handleSetNickname(client: Client, nickname: string) {
    const player = this.state.players.get(client.sessionId);
    if (!player || !nickname?.trim()) return;

    player.nickname = nickname.trim().slice(0, 20);
  }

  private handleSetPresence(client: Client, presence: Presence) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const valid: Presence[] = ["online", "playing", "offline"];
    if (valid.includes(presence)) {
      player.presence = presence;
    }
  }

  private handleInvite(client: Client, toSessionId: string) {
    const from = this.state.players.get(client.sessionId);
    const to = this.state.players.get(toSessionId);
    if (!from || !to) return;
    if (client.sessionId === toSessionId) return;

    const invite = new Invite();
    invite.id = generateInviteId();
    invite.fromSessionId = client.sessionId;
    invite.fromNickname = from.nickname;
    invite.toSessionId = toSessionId;
    invite.status = "pending";
    invite.createdAt = Date.now();

    this.state.invites.set(invite.id, invite);

    const targetClient = this.clients.find((c) => c.sessionId === toSessionId);
    if (targetClient) {
      targetClient.send("inviteReceived", {
        inviteId: invite.id,
        fromNickname: from.nickname,
        fromSessionId: client.sessionId,
      });
    }
  }

  private handleInviteResponse(client: Client, inviteId: string, accept: boolean) {
    const invite = this.state.invites.get(inviteId);
    if (!invite) return;
    if (invite.toSessionId !== client.sessionId) return;
    if (invite.status !== "pending") return;

    invite.status = accept ? "accepted" : "declined";

    const inviterClient = this.clients.find((c) => c.sessionId === invite.fromSessionId);
    if (inviterClient) {
      inviterClient.send("inviteResult", {
        inviteId: invite.id,
        accepted: accept,
        opponentSessionId: client.sessionId,
        opponentNickname: this.state.players.get(client.sessionId)?.nickname,
      });
    }

    this.clock.setTimeout(() => {
      this.state.invites.delete(inviteId);
    }, 5000);
  }
}

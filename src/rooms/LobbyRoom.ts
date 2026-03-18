import { Room, Client } from "colyseus";
import { LobbyState } from "../schemas/LobbyState";
import { PlayerState, Presence } from "../schemas/PlayerState";
import { ChatMessage } from "../schemas/ChatMessage";
import { Invite } from "../schemas/Invite";

const MAX_CHAT_HISTORY = 50;

let inviteCounter = 0;
function generateInviteId(): string {
  return `inv_${Date.now()}_${++inviteCounter}`;
}

export class LobbyRoom extends Room<LobbyState> {
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

  onJoin(client: Client, options: { nickname?: string; googleId?: string; displayName?: string; photoUrl?: string }) {
    const googleId = options.googleId;

    // Reject if no googleId
    if (!googleId) {
      client.leave();
      return;
    }

    // Unique session: disconnect previous login with same googleId
    this.state.players.forEach((existingPlayer, sessionId) => {
      if (existingPlayer.googleId === googleId && sessionId !== client.sessionId) {
        const oldClient = this.clients.find((c) => c.sessionId === sessionId);
        if (oldClient) {
          oldClient.send("kicked", { reason: "Outra sessao foi iniciada" });
          oldClient.leave();
        }
      }
    });

    const player = new PlayerState();
    player.sessionId = client.sessionId;
    player.googleId = googleId;
    player.nickname = (options.displayName || options.nickname || "Jogador").substring(0, 50);
    player.photoUrl = options.photoUrl || "";
    player.presence = "online";
    player.joinedAt = Date.now();

    this.state.players.set(client.sessionId, player);
    console.log(`${player.nickname} joined the lobby`);
  }

  onLeave(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) {
      console.log(`${player.nickname} left the lobby`);
    }
    this.state.players.delete(client.sessionId);

    // Clean up invites involving this player
    this.state.invites.forEach((invite: Invite, key: string) => {
      if (invite.fromSessionId === client.sessionId || invite.toSessionId === client.sessionId) {
        this.state.invites.delete(key);
      }
    });
  }

  private handleChat(client: Client, text: string) {
    const player = this.state.players.get(client.sessionId);
    if (!player || !text?.trim()) return;

    const sanitized = text.trim().slice(0, 200);

    const msg = new ChatMessage();
    msg.senderSessionId = client.sessionId;
    msg.senderNickname = player.nickname;
    msg.text = sanitized;
    msg.timestamp = Date.now();

    this.state.chatHistory.push(msg);

    // Trim old messages
    while (this.state.chatHistory.length > MAX_CHAT_HISTORY) {
      this.state.chatHistory.shift();
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

    // Notify the target player directly
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

    // Notify the inviter
    const inviterClient = this.clients.find((c) => c.sessionId === invite.fromSessionId);
    if (inviterClient) {
      inviterClient.send("inviteResult", {
        inviteId: invite.id,
        accepted: accept,
        opponentSessionId: client.sessionId,
        opponentNickname: this.state.players.get(client.sessionId)?.nickname,
      });
    }

    // Clean up after a delay
    this.clock.setTimeout(() => {
      this.state.invites.delete(inviteId);
    }, 5000);
  }
}

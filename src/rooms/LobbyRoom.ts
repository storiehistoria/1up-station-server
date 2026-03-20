import { Room, Client } from "colyseus";
import { LobbyState } from "../schemas/LobbyState";
import { PlayerState, Presence } from "../schemas/PlayerState";
import { Invite } from "../schemas/Invite";
import { MachineState } from "../schemas/MachineState";
import { findUser, assignCodesToNewUser, ADMIN_GOOGLE_ID } from "../services/InvitePool";

const MAX_CHAT_HISTORY = 50;
const NUM_MACHINES = 12;
const PING_WAIT_DELAY = 5000; // 5s before requesting pings
const PING_TIMEOUT = 3000; // 3s to collect pings

interface ChatMsg {
  id: string;
  senderId: string;
  senderNickname: string;
  senderPhoto: string;
  text: string;
  timestamp: number;
  type: "user" | "system";
}

// Track pending pings per machine (not in schema — server-only)
interface PendingPing {
  machineId: number;
  pings: Map<string, number>; // googleId → pingMs
  expectedPlayers: string[];
}

let msgCounter = 0;
function generateMsgId(): string {
  return `msg_${Date.now()}_${++msgCounter}`;
}

let inviteCounter = 0;
function generateInviteId(): string {
  return `inv_${Date.now()}_${++inviteCounter}`;
}

let hostCodeCounter = 0;
function generateHostCode(): string {
  return `1UP-${Date.now().toString(36).toUpperCase()}-${(++hostCodeCounter).toString(36).toUpperCase()}`;
}

export class LobbyRoom extends Room<LobbyState> {
  private chatHistory: ChatMsg[] = [];
  private pendingPings: Map<number, PendingPing> = new Map();

  onCreate() {
    this.state = new LobbyState();
    this.maxClients = 100;

    // Initialize 10 machines
    for (let i = 1; i <= NUM_MACHINES; i++) {
      const machine = new MachineState();
      machine.id = i;
      machine.status = "free";
      this.state.machines.set(String(i), machine);
    }

    // --- Heartbeat (keep proxy alive) ---
    this.onMessage("heartbeat", (client) => {
      client.send("heartbeat");
    });

    // --- Chat ---
    this.onMessage("chat", (client, data: { text: string }) => {
      this.handleChat(client, data.text);
    });

    // --- Player ---
    this.onMessage("setNickname", (client, data: { nickname: string }) => {
      this.handleSetNickname(client, data.nickname);
    });

    this.onMessage("setPresence", (client, data: { presence: Presence }) => {
      this.handleSetPresence(client, data.presence);
    });

    // --- Invites ---
    this.onMessage("invite", (client, data: { toSessionId: string }) => {
      this.handleInvite(client, data.toSessionId);
    });

    this.onMessage("inviteResponse", (client, data: { inviteId: string; accept: boolean }) => {
      this.handleInviteResponse(client, data.inviteId, data.accept);
    });

    // --- Machines ---
    this.onMessage("machine:open", (client, data: {
      machineId: number;
      gameName: string;
      maxPlayers: number;
      isOpenRoom: boolean;
      inviteSessionIds?: string[];
    }) => {
      this.handleMachineOpen(client, data);
    });

    this.onMessage("machine:join", (client, data: { machineId: number }) => {
      this.handleMachineJoin(client, data.machineId);
    });

    this.onMessage("machine:leave", (client, data: { machineId: number }) => {
      this.handleMachineLeave(client, data.machineId);
    });

    this.onMessage("machine:ping", (client, data: { machineId: number; pingMs: number }) => {
      this.handleMachinePing(client, data.machineId, data.pingMs);
    });

    // Host sends the real Dolphin traversal code after launching
    this.onMessage("machine:traversalCode", (client, data: { machineId: number; traversalCode: string }) => {
      this.handleTraversalCode(client, data.machineId, data.traversalCode);
    });

    console.log("LobbyRoom created");
  }

  // =====================
  // JOIN / LEAVE
  // =====================

  async onJoin(client: Client, options: { nickname?: string; googleId?: string; displayName?: string; photoUrl?: string; email?: string }) {
    const googleId = options.googleId;

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

    // System message: player joined
    this.broadcastSystemMessage(`${displayName} entrou no lobby`, client);

    // Send chat history to the new client
    client.send("chatHistory", this.chatHistory);

    // Assign pool codes to new users
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
      this.broadcastSystemMessage(`${player.nickname} saiu do lobby`);

      // Remove player from any machine they're in
      this.removePlayerFromAllMachines(player.googleId, player.nickname);
    }
    this.state.players.delete(client.sessionId);

    // Clean up invites
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

  // =====================
  // CHAT
  // =====================

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

    if (except) {
      this.broadcast("chat", msg, { except });
    } else {
      this.broadcast("chat", msg);
    }
  }

  // =====================
  // PLAYER SETTINGS
  // =====================

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

  // =====================
  // INVITES (legacy)
  // =====================

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

  // =====================
  // MACHINES
  // =====================

  private findPlayerGoogleId(client: Client): string | null {
    const player = this.state.players.get(client.sessionId);
    return player ? player.googleId : null;
  }

  private findClientByGoogleId(googleId: string): Client | undefined {
    let targetSessionId: string | null = null;
    this.state.players.forEach((p, sid) => {
      if (p.googleId === googleId) targetSessionId = sid;
    });
    if (!targetSessionId) return undefined;
    return this.clients.find((c) => c.sessionId === targetSessionId);
  }

  private isPlayerInAnyMachine(googleId: string): number | null {
    let found: number | null = null;
    this.state.machines.forEach((machine) => {
      if (machine.status !== "free" && machine.playerGoogleIds.includes(googleId)) {
        found = machine.id;
      }
    });
    return found;
  }

  private handleMachineOpen(client: Client, data: {
    machineId: number;
    gameName: string;
    maxPlayers: number;
    isOpenRoom: boolean;
    inviteSessionIds?: string[];
  }) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const machine = this.state.machines.get(String(data.machineId));
    if (!machine || machine.status !== "free") {
      client.send("machine:error", { message: "Maquina nao esta disponivel" });
      return;
    }

    // Check if player is already in a machine
    const existing = this.isPlayerInAnyMachine(player.googleId);
    if (existing !== null) {
      client.send("machine:error", { message: `Voce ja esta na Maquina ${existing}` });
      return;
    }

    const maxPlayers = Math.min(Math.max(data.maxPlayers || 1, 1), 4);
    const gameName = (data.gameName || "").substring(0, 100);

    machine.status = "waiting";
    machine.hostSessionId = client.sessionId;
    machine.hostNickname = player.nickname;
    machine.hostGoogleId = player.googleId;
    machine.gameName = gameName;
    machine.maxPlayers = maxPlayers;
    machine.isOpenRoom = data.isOpenRoom;
    machine.openedAt = Date.now();
    machine.playerGoogleIds.push(player.googleId);
    machine.playerNicknames.push(player.nickname);

    // Update player presence
    player.presence = "playing";

    console.log(`${player.nickname} opened Machine ${data.machineId} — ${gameName} (${maxPlayers}P)`);

    // Solo play: start immediately
    if (maxPlayers === 1) {
      machine.status = "playing";
      client.send("machine:solo", { machineId: data.machineId, gameName });
      this.broadcastSystemMessage(`${player.nickname} esta jogando ${gameName} na Maquina ${data.machineId}`);
      return;
    }

    // Open room: announce in chat
    if (data.isOpenRoom) {
      this.broadcastSystemMessage(
        `${player.nickname} abriu a Maquina ${data.machineId} — ${gameName} — ${maxPlayers} jogadores. Quem quiser entrar e so clicar!`
      );
    }

    // Send invites if specified
    if (data.inviteSessionIds && data.inviteSessionIds.length > 0) {
      for (const targetSessionId of data.inviteSessionIds) {
        const targetClient = this.clients.find((c) => c.sessionId === targetSessionId);
        if (targetClient) {
          targetClient.send("machine:invite", {
            machineId: data.machineId,
            hostNickname: player.nickname,
            gameName,
          });
        }
      }
    }

    // Check if already full (shouldn't happen with 1 player and maxPlayers > 1)
    this.checkMachineFull(data.machineId);
  }

  private handleMachineJoin(client: Client, machineId: number) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const machine = this.state.machines.get(String(machineId));
    if (!machine || machine.status !== "waiting") {
      client.send("machine:error", { message: "Maquina nao esta aceitando jogadores" });
      return;
    }

    // Check if already in a machine
    const existing = this.isPlayerInAnyMachine(player.googleId);
    if (existing !== null) {
      client.send("machine:error", { message: `Voce ja esta na Maquina ${existing}` });
      return;
    }

    // Check if full
    if (machine.playerGoogleIds.length >= machine.maxPlayers) {
      client.send("machine:error", { message: "Maquina cheia" });
      return;
    }

    machine.playerGoogleIds.push(player.googleId);
    machine.playerNicknames.push(player.nickname);
    player.presence = "playing";

    console.log(`${player.nickname} joined Machine ${machineId} (${machine.playerGoogleIds.length}/${machine.maxPlayers})`);

    this.broadcastSystemMessage(
      `${player.nickname} entrou na Maquina ${machineId} (${machine.playerGoogleIds.length}/${machine.maxPlayers})`
    );

    this.checkMachineFull(machineId);
  }

  private handleMachineLeave(client: Client, machineId: number) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    this.removePlayerFromMachine(machineId, player.googleId, player.nickname);
  }

  private removePlayerFromMachine(machineId: number, googleId: string, nickname: string) {
    const machine = this.state.machines.get(String(machineId));
    if (!machine || machine.status === "free") return;

    const idx = machine.playerGoogleIds.indexOf(googleId);
    if (idx === -1) return;

    machine.playerGoogleIds.splice(idx, 1);
    machine.playerNicknames.splice(idx, 1);

    // Reset player presence
    const playerClient = this.findClientByGoogleId(googleId);
    if (playerClient) {
      const playerState = this.state.players.get(playerClient.sessionId);
      if (playerState) playerState.presence = "online";
    }

    // If host left or no players remain, close the machine
    if (machine.playerGoogleIds.length === 0 || googleId === machine.hostGoogleId) {
      // Notify remaining players
      for (const remainingGId of [...machine.playerGoogleIds]) {
        const c = this.findClientByGoogleId(remainingGId);
        if (c) {
          c.send("machine:closed", { machineId });
          const ps = this.state.players.get(c.sessionId);
          if (ps) ps.presence = "online";
        }
      }
      this.resetMachine(machine);
      this.broadcastSystemMessage(`${nickname} encerrou a Maquina ${machineId}`);
      // Clear any pending pings
      this.pendingPings.delete(machineId);
    } else {
      this.broadcastSystemMessage(`${nickname} saiu da Maquina ${machineId} (${machine.playerGoogleIds.length}/${machine.maxPlayers})`);
    }
  }

  private removePlayerFromAllMachines(googleId: string, nickname: string) {
    this.state.machines.forEach((machine) => {
      if (machine.status !== "free" && machine.playerGoogleIds.includes(googleId)) {
        this.removePlayerFromMachine(machine.id, googleId, nickname);
      }
    });
  }

  private resetMachine(machine: MachineState) {
    machine.status = "free";
    machine.hostSessionId = "";
    machine.hostNickname = "";
    machine.hostGoogleId = "";
    machine.gameName = "";
    machine.maxPlayers = 0;
    machine.isOpenRoom = true;
    machine.openedAt = 0;
    machine.playerGoogleIds.clear();
    machine.playerNicknames.clear();
  }

  // =====================
  // AUTO-START (ping → buffer → ready)
  // =====================

  private checkMachineFull(machineId: number) {
    const machine = this.state.machines.get(String(machineId));
    if (!machine || machine.status !== "waiting") return;
    if (machine.playerGoogleIds.length < machine.maxPlayers) return;

    console.log(`Machine ${machineId} is full — starting ping sequence`);
    machine.status = "playing";

    // Wait 5 seconds for connections to stabilize, then request pings
    this.clock.setTimeout(() => {
      this.requestPings(machineId);
    }, PING_WAIT_DELAY);
  }

  private requestPings(machineId: number) {
    const machine = this.state.machines.get(String(machineId));
    if (!machine || machine.status !== "playing") return;

    const expectedPlayers = [...machine.playerGoogleIds];
    this.pendingPings.set(machineId, {
      machineId,
      pings: new Map(),
      expectedPlayers,
    });

    // Request ping from all players in this machine
    for (const googleId of expectedPlayers) {
      const client = this.findClientByGoogleId(googleId);
      if (client) {
        client.send("machine:ping_request", { machineId });
      }
    }

    // Timeout: proceed with whatever pings we have after PING_TIMEOUT
    this.clock.setTimeout(() => {
      this.finalizePings(machineId);
    }, PING_TIMEOUT);
  }

  private handleMachinePing(client: Client, machineId: number, pingMs: number) {
    const googleId = this.findPlayerGoogleId(client);
    if (!googleId) return;

    const pending = this.pendingPings.get(machineId);
    if (!pending) return;

    pending.pings.set(googleId, pingMs);

    // Check if all pings received
    if (pending.pings.size >= pending.expectedPlayers.length) {
      this.finalizePings(machineId);
    }
  }

  private finalizePings(machineId: number) {
    const pending = this.pendingPings.get(machineId);
    if (!pending) return;

    this.pendingPings.delete(machineId);

    const machine = this.state.machines.get(String(machineId));
    if (!machine || machine.status !== "playing") return;

    // Calculate max ping and buffer
    let maxPing = 0;
    pending.pings.forEach((ping) => {
      if (ping > maxPing) maxPing = ping;
    });

    // If no pings received, use default
    if (maxPing === 0) maxPing = 16;

    const buffer = Math.max(Math.ceil(maxPing / 16), 1);
    const hostCode = generateHostCode();

    console.log(`Machine ${machineId} ready — maxPing: ${maxPing}ms, buffer: ${buffer}`);

    // Send ready ONLY to the host — host will launch Dolphin and report the traversal code
    const hostClient = this.findClientByGoogleId(machine.hostGoogleId);
    if (hostClient) {
      hostClient.send("machine:ready", {
        machineId,
        buffer,
        hostCode: "", // not used anymore — real traversal code comes from Dolphin
        gameName: machine.gameName,
        isHost: true,
        maxPing,
        pings: Object.fromEntries(pending.pings),
      });
    }

    // Non-host players wait for the traversal code
    for (const googleId of machine.playerGoogleIds) {
      if (googleId === machine.hostGoogleId) continue;
      const client = this.findClientByGoogleId(googleId);
      if (client) {
        client.send("machine:waitingHost", {
          machineId,
          gameName: machine.gameName,
        });
      }
    }
  }

  private handleTraversalCode(client: Client, machineId: number, traversalCode: string) {
    const googleId = this.findPlayerGoogleId(client);
    if (!googleId) return;

    const machine = this.state.machines.get(String(machineId));
    if (!machine || machine.status !== "playing") return;

    // Only the host can send the traversal code
    if (googleId !== machine.hostGoogleId) return;

    console.log(`[NETPLAY 4] SERVIDOR: Traversal code recebido: ${traversalCode}, repassando pro cliente...`);

    // Send the real join code to all non-host players
    for (const playerId of machine.playerGoogleIds) {
      if (playerId === machine.hostGoogleId) continue;
      const playerClient = this.findClientByGoogleId(playerId);
      if (playerClient) {
        playerClient.send("machine:joinCode", {
          machineId,
          traversalCode,
          gameName: machine.gameName,
        });
      }
    }
  }
}

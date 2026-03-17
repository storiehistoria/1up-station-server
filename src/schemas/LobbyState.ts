import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";
import { PlayerState } from "./PlayerState";
import { ChatMessage } from "./ChatMessage";
import { Invite } from "./Invite";

export class LobbyState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type([ChatMessage]) chatHistory = new ArraySchema<ChatMessage>();
  @type({ map: Invite }) invites = new MapSchema<Invite>();
}

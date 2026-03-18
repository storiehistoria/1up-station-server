import { Schema, MapSchema, type } from "@colyseus/schema";
import { PlayerState } from "./PlayerState";
import { Invite } from "./Invite";

export class LobbyState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type({ map: Invite }) invites = new MapSchema<Invite>();
}

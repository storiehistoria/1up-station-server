import { Schema, MapSchema, type } from "@colyseus/schema";
import { PlayerState } from "./PlayerState";
import { Invite } from "./Invite";
import { MachineState } from "./MachineState";

export class LobbyState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type({ map: Invite }) invites = new MapSchema<Invite>();
  @type({ map: MachineState }) machines = new MapSchema<MachineState>();
}

import { Schema, ArraySchema, type } from "@colyseus/schema";

export type MachineStatus = "free" | "waiting" | "playing";

export class MachineState extends Schema {
  @type("number") id: number = 0;
  @type("string") status: MachineStatus = "free";
  @type("string") hostSessionId: string = "";
  @type("string") hostNickname: string = "";
  @type("string") hostGoogleId: string = "";
  @type("string") gameName: string = "";
  @type("number") maxPlayers: number = 0;
  @type(["string"]) playerGoogleIds = new ArraySchema<string>();
  @type(["string"]) playerNicknames = new ArraySchema<string>();
  @type("boolean") isOpenRoom: boolean = true;
}

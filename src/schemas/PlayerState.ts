import { Schema, type } from "@colyseus/schema";

export type Presence = "online" | "playing" | "offline";

export class PlayerState extends Schema {
  @type("string") sessionId: string = "";
  @type("string") googleId: string = "";
  @type("string") nickname: string = "";
  @type("string") photoUrl: string = "";
  @type("string") presence: Presence = "online";
  @type("number") joinedAt: number = 0;
}

import { Schema, type } from "@colyseus/schema";

export class Invite extends Schema {
  @type("string") id: string = "";
  @type("string") fromSessionId: string = "";
  @type("string") fromNickname: string = "";
  @type("string") toSessionId: string = "";
  @type("string") status: string = "pending"; // pending | accepted | declined
  @type("number") createdAt: number = 0;
}

import { Schema, type } from "@colyseus/schema";

export class ChatMessage extends Schema {
  @type("string") senderSessionId: string = "";
  @type("string") senderNickname: string = "";
  @type("string") text: string = "";
  @type("number") timestamp: number = 0;
}

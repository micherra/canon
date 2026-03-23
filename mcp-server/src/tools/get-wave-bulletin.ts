import { readBulletin, type BulletinMessage } from "../orchestration/bulletin.js";

export interface GetWaveBulletinInput {
  workspace: string;
  wave: number;
  since?: string;
  type?: string;
}

export interface GetWaveBulletinResult {
  messages: BulletinMessage[];
  count: number;
}

export async function getWaveBulletin(input: GetWaveBulletinInput): Promise<GetWaveBulletinResult> {
  const messages = await readBulletin(input.workspace, input.wave, {
    since: input.since,
    type: input.type,
  });

  return { messages, count: messages.length };
}

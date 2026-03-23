import { readBulletin, type BulletinMessage } from "../orchestration/bulletin.js";
import { readPendingEvents } from "../orchestration/wave-events.js";
import type { WaveEvent } from "../orchestration/flow-schema.js";

export interface GetWaveBulletinInput {
  workspace: string;
  wave: number;
  since?: string;
  type?: string;
  include_events?: boolean;
}

export interface GetWaveBulletinResult {
  messages: BulletinMessage[];
  count: number;
  events?: WaveEvent[];
  events_count?: number;
}

export async function getWaveBulletin(input: GetWaveBulletinInput): Promise<GetWaveBulletinResult> {
  const messages = await readBulletin(input.workspace, input.wave, {
    since: input.since,
    type: input.type,
  });

  const result: GetWaveBulletinResult = { messages, count: messages.length };

  if (input.include_events) {
    const events = await readPendingEvents(input.workspace);
    result.events = events;
    result.events_count = events.length;
  }

  return result;
}

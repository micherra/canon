import { postBulletin, type BulletinMessage } from "../orchestration/bulletin.ts";

export interface PostWaveBulletinInput {
  workspace: string;
  wave: number;
  from: string;
  type: "created_utility" | "established_pattern" | "discovered_gotcha" | "needs_input" | "fyi";
  summary: string;
  detail?: {
    path?: string;
    exports?: string[];
    pattern?: string;
    issue?: string;
  };
}

export interface PostWaveBulletinResult {
  message: BulletinMessage;
}

export async function postWaveBulletin(input: PostWaveBulletinInput): Promise<PostWaveBulletinResult> {
  const message = await postBulletin(input.workspace, input.wave, {
    from: input.from,
    type: input.type,
    summary: input.summary,
    detail: input.detail ?? {},
  });

  return { message };
}

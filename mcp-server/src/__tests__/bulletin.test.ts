import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { bulletinPath, postBulletin, readBulletin, buildBulletinInstructions } from "../orchestration/bulletin.js";
import { postWaveBulletin } from "../tools/post-wave-bulletin.js";
import { getWaveBulletin } from "../tools/get-wave-bulletin.js";

describe("bulletin", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "canon-bulletin-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  describe("bulletinPath", () => {
    it("computes correct zero-padded path", () => {
      const result = bulletinPath("/tmp/workspace", 2);
      expect(result).toBe("/tmp/workspace/waves/002/bulletin.jsonl");
    });

    it("pads single-digit wave numbers", () => {
      expect(bulletinPath("/tmp/ws", 1)).toBe("/tmp/ws/waves/001/bulletin.jsonl");
    });

    it("pads double-digit wave numbers", () => {
      expect(bulletinPath("/tmp/ws", 42)).toBe("/tmp/ws/waves/042/bulletin.jsonl");
    });

    it("preserves triple-digit wave numbers", () => {
      expect(bulletinPath("/tmp/ws", 100)).toBe("/tmp/ws/waves/100/bulletin.jsonl");
    });
  });

  describe("postBulletin", () => {
    it("creates directories and writes JSONL with timestamp", async () => {
      const message = await postBulletin(workspace, 1, {
        from: "agent-a",
        type: "created_utility",
        summary: "Created shared date formatter",
        detail: {
          path: "src/utils/date.ts",
          exports: ["formatDate", "parseDate"],
        },
      });

      expect(message.timestamp).toBeDefined();
      expect(new Date(message.timestamp).getTime()).not.toBeNaN();
      expect(message.from).toBe("agent-a");
      expect(message.type).toBe("created_utility");
      expect(message.summary).toBe("Created shared date formatter");
      expect(message.detail.path).toBe("src/utils/date.ts");
      expect(message.detail.exports).toEqual(["formatDate", "parseDate"]);
    });

    it("appends multiple messages to the same file", async () => {
      await postBulletin(workspace, 1, {
        from: "agent-a",
        type: "created_utility",
        summary: "First message",
        detail: {},
      });

      await postBulletin(workspace, 1, {
        from: "agent-b",
        type: "discovered_gotcha",
        summary: "Second message",
        detail: { issue: "env var missing" },
      });

      const messages = await readBulletin(workspace, 1);
      expect(messages).toHaveLength(2);
      expect(messages[0].from).toBe("agent-a");
      expect(messages[1].from).toBe("agent-b");
    });
  });

  describe("readBulletin", () => {
    it("returns empty array when file does not exist", async () => {
      const messages = await readBulletin(workspace, 99);
      expect(messages).toEqual([]);
    });

    it("reads posted messages", async () => {
      await postBulletin(workspace, 1, {
        from: "agent-a",
        type: "fyi",
        summary: "Just an FYI",
        detail: {},
      });

      const messages = await readBulletin(workspace, 1);
      expect(messages).toHaveLength(1);
      expect(messages[0].from).toBe("agent-a");
      expect(messages[0].type).toBe("fyi");
      expect(messages[0].summary).toBe("Just an FYI");
    });

    it("filters by since timestamp", async () => {
      await postBulletin(workspace, 1, {
        from: "agent-a",
        type: "fyi",
        summary: "Old message",
        detail: {},
      });

      // Small delay to ensure distinct timestamps
      await new Promise(resolve => setTimeout(resolve, 10));
      const cutoff = new Date().toISOString();
      await new Promise(resolve => setTimeout(resolve, 10));

      await postBulletin(workspace, 1, {
        from: "agent-b",
        type: "fyi",
        summary: "New message",
        detail: {},
      });

      const messages = await readBulletin(workspace, 1, { since: cutoff });
      expect(messages).toHaveLength(1);
      expect(messages[0].from).toBe("agent-b");
      expect(messages[0].summary).toBe("New message");
    });

    it("filters by type", async () => {
      await postBulletin(workspace, 1, {
        from: "agent-a",
        type: "created_utility",
        summary: "Created something",
        detail: {},
      });

      await postBulletin(workspace, 1, {
        from: "agent-b",
        type: "discovered_gotcha",
        summary: "Found a gotcha",
        detail: { issue: "test flaky" },
      });

      await postBulletin(workspace, 1, {
        from: "agent-c",
        type: "created_utility",
        summary: "Created another thing",
        detail: {},
      });

      const messages = await readBulletin(workspace, 1, { type: "created_utility" });
      expect(messages).toHaveLength(2);
      expect(messages[0].from).toBe("agent-a");
      expect(messages[1].from).toBe("agent-c");
    });
  });

  describe("buildBulletinInstructions", () => {
    it("includes wave number and peer count", () => {
      const instructions = buildBulletinInstructions(3, 4);
      expect(instructions).toContain("wave 3");
      expect(instructions).toContain("4 other agents");
      expect(instructions).toContain("get_wave_bulletin");
      expect(instructions).toContain("post_wave_bulletin");
    });

    it("includes workspace path when provided", () => {
      const instructions = buildBulletinInstructions(2, 3, "/tmp/workspace");
      expect(instructions).toContain('workspace="/tmp/workspace"');
      expect(instructions).toContain("wave=2");
    });

    it("omits workspace line when not provided", () => {
      const instructions = buildBulletinInstructions(1, 2);
      expect(instructions).not.toContain("Bulletin parameters");
    });
  });

  describe("postWaveBulletin tool", () => {
    it("posts and returns message with timestamp", async () => {
      const result = await postWaveBulletin({
        workspace,
        wave: 1,
        from: "agent-x",
        type: "established_pattern",
        summary: "Use barrel exports",
        detail: {
          pattern: "All modules use index.ts barrel exports",
        },
      });

      expect(result.message.timestamp).toBeDefined();
      expect(result.message.from).toBe("agent-x");
      expect(result.message.type).toBe("established_pattern");
      expect(result.message.summary).toBe("Use barrel exports");
      expect(result.message.detail.pattern).toBe("All modules use index.ts barrel exports");
    });

    it("defaults detail to empty object when omitted", async () => {
      const result = await postWaveBulletin({
        workspace,
        wave: 1,
        from: "agent-y",
        type: "fyi",
        summary: "Heads up",
      });

      expect(result.message.detail).toEqual({});
    });
  });

  describe("getWaveBulletin tool", () => {
    it("reads messages and returns count", async () => {
      await postBulletin(workspace, 2, {
        from: "agent-a",
        type: "fyi",
        summary: "Message 1",
        detail: {},
      });

      await postBulletin(workspace, 2, {
        from: "agent-b",
        type: "needs_input",
        summary: "Message 2",
        detail: {},
      });

      const result = await getWaveBulletin({ workspace, wave: 2 });
      expect(result.count).toBe(2);
      expect(result.messages).toHaveLength(2);
    });

    it("applies type filter", async () => {
      await postBulletin(workspace, 1, {
        from: "agent-a",
        type: "fyi",
        summary: "FYI message",
        detail: {},
      });

      await postBulletin(workspace, 1, {
        from: "agent-b",
        type: "needs_input",
        summary: "Need help",
        detail: {},
      });

      const result = await getWaveBulletin({ workspace, wave: 1, type: "needs_input" });
      expect(result.count).toBe(1);
      expect(result.messages[0].type).toBe("needs_input");
    });

    it("returns empty when no bulletin exists", async () => {
      const result = await getWaveBulletin({ workspace, wave: 99 });
      expect(result.count).toBe(0);
      expect(result.messages).toEqual([]);
    });
  });
});

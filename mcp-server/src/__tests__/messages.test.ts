import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  writeMessage,
  readMessages,
  buildMessageInstructions,
  readChannelAsContext,
  channelDir,
} from "../orchestration/messages.ts";

describe("messages", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "canon-messages-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  describe("writeMessage", () => {
    it("creates a message file with correct header and content", async () => {
      const msg = await writeMessage(workspace, "wave-000", "impl-auth", "Created auth utility.");

      expect(msg.from).toBe("impl-auth");
      expect(msg.content).toBe("Created auth utility.");
      expect(msg.path).toContain("messages/wave-000/001-impl-auth.md");

      const raw = await readFile(msg.path, "utf-8");
      expect(raw).toMatch(/^<!-- from: impl-auth \|/);
      expect(raw).toContain("Created auth utility.");
    });

    it("auto-increments sequence numbers", async () => {
      await writeMessage(workspace, "test-channel", "agent-a", "First");
      await writeMessage(workspace, "test-channel", "agent-b", "Second");
      await writeMessage(workspace, "test-channel", "agent-c", "Third");

      const dir = channelDir(workspace, "test-channel");
      const files = (await readdir(dir)).filter((file) => file.endsWith(".md"));
      expect(files.sort()).toEqual([
        "001-agent-a.md",
        "002-agent-b.md",
        "003-agent-c.md",
      ]);
    });

    it("assigns unique sequence numbers under concurrent writes", async () => {
      await Promise.all([
        writeMessage(workspace, "concurrent", "agent-a", "First"),
        writeMessage(workspace, "concurrent", "agent-b", "Second"),
        writeMessage(workspace, "concurrent", "agent-c", "Third"),
      ]);

      const files = (await readdir(channelDir(workspace, "concurrent")))
        .filter((file) => file.endsWith(".md"))
        .sort();
      expect(files).toHaveLength(3);
      expect(Array.from(new Set(files))).toHaveLength(3);
      expect(files.map((file) => file.slice(0, 3))).toEqual(["001", "002", "003"]);
    });

    it("slugifies the from field for filenames", async () => {
      const msg = await writeMessage(workspace, "ch", "Team A (Architect)", "content");
      expect(msg.path).toContain("001-team-a-architect.md");
    });

    it("creates channel directories recursively", async () => {
      await writeMessage(workspace, "deep/nested/channel", "agent", "content");
      const dir = channelDir(workspace, "deep/nested/channel");
      const files = (await readdir(dir)).filter((file) => file.endsWith(".md"));
      expect(files).toHaveLength(1);
    });

    it("rejects channels that escape the workspace", async () => {
      await expect(
        writeMessage(workspace, "../outside", "agent", "content"),
      ).rejects.toThrow("Invalid channel");
    });
  });

  describe("readMessages", () => {
    it("returns empty array for non-existent channel", async () => {
      const messages = await readMessages(workspace, "nonexistent");
      expect(messages).toEqual([]);
    });

    it("rejects reads from channels that escape the workspace", async () => {
      await expect(readMessages(workspace, "../outside")).rejects.toThrow("Invalid channel");
    });

    it("reads messages in order", async () => {
      await writeMessage(workspace, "ch", "alice", "First message");
      await writeMessage(workspace, "ch", "bob", "Second message");
      await writeMessage(workspace, "ch", "charlie", "Third message");

      const messages = await readMessages(workspace, "ch");
      expect(messages).toHaveLength(3);
      expect(messages[0].from).toBe("alice");
      expect(messages[0].content).toBe("First message");
      expect(messages[1].from).toBe("bob");
      expect(messages[2].from).toBe("charlie");
    });

    it("filters by since timestamp", async () => {
      const first = await writeMessage(workspace, "ch", "agent", "Old");
      // Ensure a gap
      const since = new Date(Date.now() + 100).toISOString();

      // Manually write a message with a future timestamp
      const { writeFile, mkdir } = await import("fs/promises");
      const dir = channelDir(workspace, "ch");
      const futureTs = new Date(Date.now() + 200).toISOString();
      await writeFile(
        join(dir, "002-agent.md"),
        `<!-- from: agent | ${futureTs} -->\n\nNew message`,
        "utf-8",
      );

      const messages = await readMessages(workspace, "ch", { since });
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("New message");
    });

    it("skips files without valid headers", async () => {
      const { writeFile, mkdir } = await import("fs/promises");
      const dir = channelDir(workspace, "ch");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "001-bad.md"), "No header here", "utf-8");
      await writeMessage(workspace, "ch", "good", "Valid message");

      const messages = await readMessages(workspace, "ch");
      expect(messages).toHaveLength(1);
      expect(messages[0].from).toBe("good");
    });
  });

  describe("readChannelAsContext", () => {
    it("returns empty string for empty channel", async () => {
      const ctx = await readChannelAsContext(workspace, "empty");
      expect(ctx).toBe("");
    });

    it("concatenates messages with separators", async () => {
      await writeMessage(workspace, "ch", "alice", "Hello from Alice");
      await writeMessage(workspace, "ch", "bob", "Hello from Bob");

      const ctx = await readChannelAsContext(workspace, "ch");
      expect(ctx).toContain("**alice:**");
      expect(ctx).toContain("Hello from Alice");
      expect(ctx).toContain("**bob:**");
      expect(ctx).toContain("Hello from Bob");
      expect(ctx).toContain("---");
    });

    it("truncates when exceeding maxChars", async () => {
      const longContent = "x".repeat(3000);
      await writeMessage(workspace, "ch", "agent", longContent);

      const ctx = await readChannelAsContext(workspace, "ch", { maxChars: 100 });
      expect(ctx.length).toBeLessThanOrEqual(130); // 100 + truncation notice
      expect(ctx).toContain("[Messages truncated]");
    });
  });

  describe("buildMessageInstructions", () => {
    it("includes channel and workspace in instructions", () => {
      const instr = buildMessageInstructions("wave-001", 3, "/path/to/ws");
      expect(instr).toContain("wave-001");
      expect(instr).toContain("/path/to/ws");
      expect(instr).toContain("3 other agents");
    });

    it("handles singular peer count", () => {
      const instr = buildMessageInstructions("wave-001", 1, "/path/to/ws");
      expect(instr).toContain("1 other agent.");
    });
  });

  describe("channel isolation", () => {
    it("messages in different channels are independent", async () => {
      await writeMessage(workspace, "channel-a", "agent", "In A");
      await writeMessage(workspace, "channel-b", "agent", "In B");

      const a = await readMessages(workspace, "channel-a");
      const b = await readMessages(workspace, "channel-b");

      expect(a).toHaveLength(1);
      expect(a[0].content).toBe("In A");
      expect(b).toHaveLength(1);
      expect(b[0].content).toBe("In B");
    });
  });
});

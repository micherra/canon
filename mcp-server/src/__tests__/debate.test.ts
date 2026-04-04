import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildDebatePrompt,
  buildDebateSummary,
  type DebateConfig,
  heuristicConvergence,
  inspectDebateProgress,
  roundFraming,
  roundType,
} from "../orchestration/debate.ts";
import { type Message, writeMessage } from "../orchestration/messages.ts";

describe("debate", () => {
  describe("roundType", () => {
    it("returns position for round 1", () => {
      expect(roundType(1)).toBe("position");
    });

    it("returns challenge for round 2", () => {
      expect(roundType(2)).toBe("challenge");
    });

    it("returns response for round 3", () => {
      expect(roundType(3)).toBe("response");
    });

    it("returns narrow for round 4+", () => {
      expect(roundType(4)).toBe("narrow");
      expect(roundType(5)).toBe("narrow");
      expect(roundType(10)).toBe("narrow");
    });
  });

  describe("roundFraming", () => {
    it("produces position framing for round 1", () => {
      const framing = roundFraming(1, 5, "Team A", ["Team B", "Team C"]);
      expect(framing).toContain("State Your Position");
      expect(framing).toContain("Team A");
    });

    it("produces challenge framing for round 2", () => {
      const framing = roundFraming(2, 5, "Team B", ["Team A", "Team C"]);
      expect(framing).toContain("Challenge Other Positions");
      expect(framing).toContain("Team A and Team C");
    });

    it("produces response framing for round 3", () => {
      const framing = roundFraming(3, 5, "Team A", ["Team B"]);
      expect(framing).toContain("Respond to Challenges");
    });

    it("produces narrow framing for round 4+", () => {
      const framing = roundFraming(4, 5, "Team A", ["Team B"]);
      expect(framing).toContain("Focus on Remaining Disagreements");
      expect(framing).toContain("round 4 of 5");
    });
  });

  describe("heuristicConvergence", () => {
    function makeMessage(content: string): Message {
      return {
        content,
        from: "team",
        timestamp: new Date().toISOString(),
      };
    }

    it("detects convergence when majority signal agreement", () => {
      const messages: Message[] = [
        makeMessage("I agree with Team B's approach, we've converged on the same design."),
        makeMessage("We are aligned on the data model. Consensus reached."),
        makeMessage("Still disagree on the API surface."),
      ];

      const result = heuristicConvergence(messages);
      expect(result.converged).toBe(true);
      expect(result.reason).toContain("agreement");
    });

    it("does not converge when no agreement signals", () => {
      const messages: Message[] = [
        makeMessage(
          "Our approach uses event sourcing with full replay capability. This gives us complete audit trails and the ability to reconstruct any past state of the system deterministically.",
        ),
        makeMessage(
          "We prefer CRUD with audit logging for simplicity. The overhead of event sourcing is not justified for this domain where temporal queries are rare and the schema is relatively stable.",
        ),
        makeMessage(
          "A hybrid approach with selective event capture is best. We should use CRUD for most entities but capture domain events for the order lifecycle where replay and audit are critical requirements.",
        ),
      ];

      const result = heuristicConvergence(messages);
      expect(result.converged).toBe(false);
    });

    it("does not count negated convergence terms as signals", () => {
      // "don't agree", "doesn't agree", "not aligned", etc. should NOT trigger convergence
      // Messages are intentionally long to avoid the brevity heuristic (< 100 chars avg)
      const messages: Message[] = [
        makeMessage(
          "We don't agree with Team B's approach at all. Their assumptions about eventual consistency are fundamentally flawed and ignore the CAP theorem implications.",
        ),
        makeMessage(
          "We doesn't see consensus here. There is not aligned thinking between the teams on this critical architectural question regarding the data persistence layer.",
        ),
        makeMessage(
          "There is no consensus on the data model. We never agree on this point and stand firm in our position that a relational model is the wrong choice for this workload.",
        ),
      ];

      const result = heuristicConvergence(messages);
      expect(result.converged).toBe(false);
    });

    it("detects convergence only when un-negated terms are present", () => {
      const messages: Message[] = [
        makeMessage(
          "We don't agree with the caching layer, but we do agree on the API design. We are aligned on the core contract.",
        ),
        makeMessage("We agree the API structure is solid. Aligned on contracts."),
        makeMessage("I agree the API approach is the right one."),
      ];

      // 3/3 have a non-negated "agree" or "aligned" — should still converge
      const result = heuristicConvergence(messages);
      expect(result.converged).toBe(true);
    });

    it("detects convergence when messages are very short", () => {
      const messages: Message[] = [
        makeMessage("Agreed."),
        makeMessage("Same."),
        makeMessage("OK."),
      ];

      const result = heuristicConvergence(messages);
      expect(result.converged).toBe(true);
      expect(result.reason).toContain("brief");
    });

    it("returns not converged for empty messages", () => {
      const result = heuristicConvergence([]);
      expect(result.converged).toBe(false);
    });
  });

  describe("buildDebateSummary", () => {
    let workspace: string;

    beforeEach(async () => {
      workspace = await mkdtemp(join(tmpdir(), "canon-debate-"));
    });

    afterEach(async () => {
      await rm(workspace, { force: true, recursive: true });
    });

    it("returns message for empty channel", async () => {
      const summary = await buildDebateSummary(workspace, "empty-debate");
      expect(summary).toContain("No debate messages");
    });

    it("builds summary from debate messages", async () => {
      await writeMessage(workspace, "debate", "round-1-team-a", "We propose event sourcing.");
      await writeMessage(workspace, "debate", "round-1-team-b", "We propose CRUD + audit.");
      await writeMessage(workspace, "debate", "round-2-team-a", "CRUD doesn't handle replay.");

      const summary = await buildDebateSummary(workspace, "debate");
      expect(summary).toContain("Debate Summary");
      expect(summary).toContain("round-1-team-a");
      expect(summary).toContain("event sourcing");
    });

    it("infers round number from channel name (item #15)", async () => {
      // Messages posted to debate-round-3 channel — round number from channel, not msg.from
      await writeMessage(
        workspace,
        "debate-round-3",
        "some-agent-no-round",
        "Final response from Team A.",
      );
      await writeMessage(
        workspace,
        "debate-round-3",
        "another-agent",
        "Final response from Team B.",
      );

      const summary = await buildDebateSummary(workspace, "debate-round-3");
      // Should show Round 3 (from channel), not Round 0 (from msg.from fallback)
      expect(summary).toContain("Round 3");
    });

    it("falls back to msg.from round inference when channel has no round number", async () => {
      // Channel without round number — must fall back to msg.from
      await writeMessage(workspace, "debate-misc", "round-2-team-a-researcher", "Some message.");

      const summary = await buildDebateSummary(workspace, "debate-misc");
      // Should show Round 2 (from msg.from), not Round 0
      expect(summary).toContain("Round 2");
    });
  });

  describe("inspectDebateProgress", () => {
    let workspace: string;

    const config: DebateConfig = {
      composition: ["canon-researcher"],
      continue_to_build: true,
      convergence_check_after: 3,
      hitl_checkpoint: true,
      max_rounds: 4,
      min_rounds: 2,
      teams: 2,
    };

    beforeEach(async () => {
      workspace = await mkdtemp(join(tmpdir(), "canon-debate-progress-"));
    });

    afterEach(async () => {
      await rm(workspace, { force: true, recursive: true });
    });

    it("returns next_round=1 and not completed when no rounds exist", async () => {
      const progress = await inspectDebateProgress(workspace, config);
      expect(progress.completed).toBe(false);
      expect(progress.next_round).toBe(1);
      expect(progress.last_completed_round).toBe(0);
      expect(progress.next_channel).toBe("debate-round-1");
    });

    it("increments next_round as rounds are populated", async () => {
      await writeMessage(
        workspace,
        "debate-round-1",
        "round-1-team-a-canon-researcher",
        "Position A.",
      );
      await writeMessage(
        workspace,
        "debate-round-1",
        "round-1-team-b-canon-researcher",
        "Position B.",
      );

      const progress = await inspectDebateProgress(workspace, config);
      expect(progress.last_completed_round).toBe(1);
      expect(progress.next_round).toBe(2);
      expect(progress.completed).toBe(false);
    });

    it("marks completed when max_rounds are reached", async () => {
      await Promise.all(
        Array.from({ length: 4 }, (_, i) => i + 1).map((r) =>
          writeMessage(workspace, `debate-round-${r}`, `round-${r}-team-a`, `Round ${r} message.`),
        ),
      );

      const progress = await inspectDebateProgress(workspace, config);
      expect(progress.completed).toBe(true);
      expect(progress.last_completed_round).toBe(4);
    });

    it("includes transcript when rounds have messages", async () => {
      await writeMessage(
        workspace,
        "debate-round-1",
        "round-1-team-a-canon-researcher",
        "We prefer event sourcing.",
      );

      const progress = await inspectDebateProgress(workspace, config);
      expect(progress.transcript).toBeDefined();
      expect(progress.transcript).toContain("Debate Round 1");
      expect(progress.summary).toBeDefined();
    });

    it("detects convergence when messages contain agreement signals after min rounds", async () => {
      const earlyConvergeConfig: DebateConfig = {
        ...config,
        convergence_check_after: 2,
        min_rounds: 2,
      };

      // Post 2 rounds
      await writeMessage(workspace, "debate-round-1", "round-1-team-a", "Initial position.");
      await writeMessage(workspace, "debate-round-1", "round-1-team-b", "Counter position.");
      await writeMessage(
        workspace,
        "debate-round-2",
        "round-2-team-a",
        "We agree and are aligned now.",
      );
      await writeMessage(
        workspace,
        "debate-round-2",
        "round-2-team-b",
        "Consensus reached. We agree.",
      );

      const progress = await inspectDebateProgress(workspace, earlyConvergeConfig);
      expect(progress.completed).toBe(true);
      expect(progress.convergence?.converged).toBe(true);
    });
  });

  describe("buildDebatePrompt", () => {
    it("includes the base prompt", () => {
      const result = buildDebatePrompt("Design the auth system.", {
        agent: "canon-researcher",
        maxRounds: 5,
        otherTeamLabels: ["Team B", "Team C"],
        roundNumber: 1,
        teamLabel: "Team A",
        workspace: "/workspace",
      });
      expect(result).toContain("Design the auth system.");
    });

    it("includes round framing for the given round", () => {
      const result = buildDebatePrompt("Design the auth system.", {
        agent: "canon-researcher",
        maxRounds: 5,
        otherTeamLabels: ["Team B"],
        roundNumber: 1,
        teamLabel: "Team A",
        workspace: "/workspace",
      });
      expect(result).toContain("State Your Position");
      expect(result).toContain("Team A");
    });

    it("includes post_message coordination instructions with correct channel", () => {
      const result = buildDebatePrompt("Brief.", {
        agent: "canon-architect",
        maxRounds: 5,
        otherTeamLabels: ["Team A"],
        roundNumber: 2,
        teamLabel: "Team B",
        workspace: "/workspace/test",
      });
      expect(result).toContain('channel="debate-round-2"');
      expect(result).toContain('workspace="/workspace/test"');
    });

    it("includes prior transcript when provided", () => {
      const transcript = "### Round 1\n\nTeam A: Use event sourcing.";
      const result = buildDebatePrompt("Brief.", {
        agent: "canon-architect",
        maxRounds: 5,
        otherTeamLabels: ["Team A"],
        roundNumber: 2,
        teamLabel: "Team B",
        transcript,
        workspace: "/workspace",
      });
      expect(result).toContain("Prior Debate Transcript");
      expect(result).toContain("Use event sourcing.");
    });

    it("omits transcript section when not provided", () => {
      const result = buildDebatePrompt("Brief.", {
        agent: "canon-researcher",
        maxRounds: 5,
        otherTeamLabels: ["Team B"],
        roundNumber: 1,
        teamLabel: "Team A",
        workspace: "/workspace",
      });
      expect(result).not.toContain("Prior Debate Transcript");
    });
  });
});

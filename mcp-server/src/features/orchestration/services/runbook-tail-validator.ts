/**
 * Runbook tail validation — verifies that a runbook ends with the mandatory
 * tail sequence: ship → context-sync → learn.
 */

/**
 * Extract step IDs from YAML code blocks in runbook content.
 * Matches `- id: <value>` entries within fenced code blocks.
 */
export function extractStepIds(runbookContent: string): string[] {
  // Find all YAML code blocks
  const codeBlockPattern = /```ya?ml([\s\S]*?)```/g;
  const stepIds: string[] = [];
  let match: RegExpExecArray | null;

  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
  while ((match = codeBlockPattern.exec(runbookContent)) !== null) {
    const block = match[1];
    // Extract all `id: <value>` entries in this block (dash prefix optional)
    const idPattern = /^\s*(?:-\s+)?id:\s+(\S+)/gm;
    let idMatch: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
    while ((idMatch = idPattern.exec(block)) !== null) {
      stepIds.push(idMatch[1]);
    }
  }

  return stepIds;
}

/**
 * Validate that a runbook ends with the mandatory tail: ship → context-sync → learn.
 * Returns a preflight issue message if validation fails, null if valid.
 * Fails closed: if step IDs cannot be parsed, returns an issue.
 */
export function validateRunbookTail(runbookContent: string): string | null {
  const stepIds = extractStepIds(runbookContent);

  if (stepIds.length === 0) {
    return "Runbook tail validation: no step IDs found in runbook YAML blocks — cannot verify mandatory tail (ship → context-sync → learn)";
  }

  const tail = stepIds.slice(-3);
  if (tail.length < 3 || tail[0] !== "ship" || tail[1] !== "context-sync" || tail[2] !== "learn") {
    const found = tail.join(" → ");
    return `Runbook tail validation: last three steps must be "ship → context-sync → learn" but found "${found}". Add the mandatory tail steps in order.`;
  }

  return null;
}

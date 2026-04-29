# Canon Templates

This directory contains structured output templates that Canon's specialist agents use to produce consistent, parseable artifacts. Templates are how Canon ensures that the implementor's summary has the sections the tester needs, and that the planner's research notes have the structure the architect expects.

## Why Templates Matter

Canon's pipeline is multi-agent: a planner produces research notes that an architect reads, an architect produces a task plan that an implementor executes, an implementor produces a summary that a tester verifies. If each agent invents its own output format, the downstream agent can't reliably parse the upstream output. Templates solve this by defining the contract between producer and consumer.

The `agent-template-required` rule enforces this: agents must read and follow the provided template before producing any artifact. An agent that skips the template and invents its own structure is violating this rule — even if the output looks reasonable, the downstream agent may miss critical sections.

## Template Format

Each template is a markdown file with YAML frontmatter describing the template's purpose and which agents use it. The body contains the expected structure with placeholder sections that agents fill in. Some sections are mandatory; others are conditional (include only if relevant, like a "Concerns" section that only appears when there are concerns to flag).

Templates use `{placeholder}` syntax for required fields, comment blocks (`<!-- ... -->`) for guidance text that agents should replace, and checkbox lists (`- [ ]`) for verification steps.

## The Template Set

Templates cover the major artifact types in the Canon pipeline:

The **implementation log** is what the implementor produces after completing a task — what changed, files modified, tests written, coverage notes, and Canon compliance declarations. The tester reads this first to understand what was tested and what gaps remain.

The **research notes** are the planner's structured output capturing codebase investigation findings — what was discovered, confidence level, source evidence, and open questions for the architect.

The **design decision** captures an architect's analysis: the options considered, tradeoffs evaluated, chosen approach, and consequences. These become the decisions referenced by task plans.

The **task plan** is the implementor's instruction set — the atomic unit of work decomposed from a larger design. It specifies the files to touch, the actions to take, the principles to apply, and the verification steps to run.

Other templates cover test reports, review checklists, security assessments, context sync reports, wave briefings, PR descriptions, and more. The full registry is in the `.claude/CLAUDE.md` file for this directory.

## Adding a New Template

Create a markdown file named `{artifact-type}.md`. Define the YAML frontmatter identifying which agents use it and which agents read it. Write the body structure with clear placeholder sections. Update the template registry in `.claude/CLAUDE.md` and in the `agent-template-required` rule in `rules/` so the rule table reflects the new template.

When designing a template's structure, start from the downstream consumer's perspective: what sections does the reading agent need to find reliably? Design the template around those requirements, then add supplementary sections for producer use.

/**
 * Pure functions for variable substitution in spawn prompts.
 */

/**
 * Replace all `${key}` patterns in the template with values from vars.
 * If a key has no value in vars, the `${key}` pattern is left unchanged.
 * Supports nested patterns like `${item.field}` by looking up "item.field" as the key.
 *
 * Escaped patterns `\${key}` are skipped during substitution and unescaped to
 * `${key}` in the output. This allows KG summaries and other injected content
 * to contain literal `${...}` text without triggering variable expansion.
 */
export function substituteVariables(template: string, vars: Record<string, string>): string {
  return template.replace(/(\\?)\$\{([^}]+)\}/g, (match, prefix: string, key: string) => {
    // Escaped pattern \${...} — strip the backslash and return the literal ${...}
    if (prefix === "\\") {
      return `\${${key}}`;
    }
    return key in vars ? vars[key] : match;
  });
}

/**
 * Given template name(s), return instruction text directing an agent to use the template(s).
 * Each template gets its own instruction line.
 */
export function buildTemplateInjection(templates: string | string[], pluginDir: string): string {
  const names = Array.isArray(templates) ? templates : [templates];
  return names
    .map(
      (name) =>
        `Use the ${name} template at \`${pluginDir}/templates/${name}.md\`. Read the template first and follow its structure exactly.`,
    )
    .join("\n");
}

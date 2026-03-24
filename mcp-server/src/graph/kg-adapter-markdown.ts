/**
 * Markdown Language Adapter
 *
 * Extracts Canon entities from Markdown files using gray-matter for
 * frontmatter parsing and remark for body content analysis.
 */

// @ts-ignore esModuleInterop handles this at project level; single-file tsc needs the suppression
import matter from 'gray-matter';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import type {
  LanguageAdapter,
  AdapterResult,
  EntityKind,
  IntraFileEdge,
  ImportSpecifier,
} from './kg-types.js';

// ---------------------------------------------------------------------------
// Entity kind classification
// ---------------------------------------------------------------------------

/**
 * Classify the Canon entity kind from frontmatter data and file path.
 * Returns null if the file doesn't match a known Canon entity type.
 */
function classifyEntityKind(
  filePath: string,
  data: Record<string, unknown>
): EntityKind | null {
  // Principle: has a `severity` frontmatter field
  if ('severity' in data) {
    return 'principle';
  }

  // Flow fragment: located in flows/fragments/
  if (filePath.includes('/flows/fragments/') || filePath.includes('flows/fragments/')) {
    return 'flow-fragment';
  }

  // Flow: has `tier` or `states` frontmatter field
  if ('tier' in data || 'states' in data) {
    return 'flow';
  }

  // Agent: has `role` and is located in agents/ directory
  if ('role' in data && (filePath.includes('/agents/') || filePath.includes('agents/'))) {
    return 'agent';
  }

  // Template: located in templates/ directory
  if (filePath.includes('/templates/') || filePath.includes('templates/')) {
    return 'template';
  }

  // Decision: has `status` and is located in decisions/ directory
  if (
    'status' in data &&
    (filePath.includes('/decisions/') || filePath.includes('decisions/'))
  ) {
    return 'decision';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Metadata extraction
// ---------------------------------------------------------------------------

function extractMetadata(
  kind: EntityKind | null,
  data: Record<string, unknown>
): Record<string, unknown> | null {
  switch (kind) {
    case 'principle':
      return {
        severity: data['severity'] ?? null,
        tags: Array.isArray(data['tags']) ? data['tags'] : [],
        layers: Array.isArray(data['layers']) ? data['layers'] : [],
      };
    case 'flow':
    case 'flow-fragment':
      return {
        tier: data['tier'] ?? null,
        states: Array.isArray(data['states']) ? data['states'] : [],
      };
    case 'agent':
      return { role: data['role'] ?? null };
    case 'decision':
      return { status: data['status'] ?? null };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Relative path detection
// ---------------------------------------------------------------------------

function isRelativePath(url: string): boolean {
  // Relative paths start with ./ or ../ or are bare paths without a protocol
  return (
    url.startsWith('./') ||
    url.startsWith('../') ||
    (!url.includes('://') && !url.startsWith('#') && !url.startsWith('mailto:'))
  );
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export const markdownAdapter: LanguageAdapter = {
  extensions: ['.md'],

  parse(filePath: string, content: string): AdapterResult {
    // -------------------------------------------------------------------------
    // Phase 1: Frontmatter extraction (gray-matter)
    // -------------------------------------------------------------------------
    const parsed = matter(content);
    const frontmatterData = parsed.data as Record<string, unknown>;

    const kind = classifyEntityKind(filePath, frontmatterData);
    const metadata = extractMetadata(kind, frontmatterData);

    // Derive a display name from the file path (basename without extension)
    const pathParts = filePath.replace(/\\/g, '/').split('/');
    const basename = pathParts[pathParts.length - 1] ?? filePath;
    const name = (frontmatterData['title'] as string | undefined) ?? basename.replace(/\.md$/, '');

    // The qualified name is the file path itself (unique per file)
    const qualifiedName = filePath;

    const entities: AdapterResult['entities'] = [];
    const intraFileEdges: IntraFileEdge[] = [];
    const importSpecifiers: ImportSpecifier[] = [];

    // Count lines in content so we can set line_end
    const lineCount = content.split('\n').length;

    // Emit the canonical entity for this file
    const entityKind: EntityKind = kind ?? 'file';
    entities.push({
      name,
      qualified_name: qualifiedName,
      kind: entityKind,
      line_start: 1,
      line_end: lineCount,
      is_exported: true,
      is_default_export: false,
      signature: null,
      metadata: metadata ? JSON.stringify(metadata) : null,
    });

    // -------------------------------------------------------------------------
    // Phase 2: Body parsing (remark)
    // -------------------------------------------------------------------------
    const processor = unified()
      .use(remarkParse)
      .use(remarkFrontmatter)
      .use(remarkGfm);

    const tree = processor.parse(content);

    // Track backtick references for doc:references edges
    const backtickRefs: string[] = [];
    // Track link URLs for import specifiers and doc:references edges
    const linkUrls: string[] = [];

    visit(tree, (node) => {
      // Links: extract URL for relative file references
      if (node.type === 'link') {
        const linkNode = node as { type: 'link'; url: string };
        const url = linkNode.url;
        if (url && isRelativePath(url)) {
          linkUrls.push(url);
        }
      }

      // Inline code spans: record raw name for doc:references
      if (node.type === 'inlineCode') {
        const codeNode = node as { type: 'inlineCode'; value: string };
        const val = codeNode.value.trim();
        if (val.length > 0) {
          backtickRefs.push(val);
        }
      }
    });

    // -------------------------------------------------------------------------
    // Frontmatter field references (includes, template, agent, etc.)
    // -------------------------------------------------------------------------
    const fmRefFields = ['includes', 'template', 'agent', 'extends', 'inherits'];
    for (const field of fmRefFields) {
      const val = frontmatterData[field];
      if (typeof val === 'string' && isRelativePath(val)) {
        importSpecifiers.push({ specifier: val, names: [] });
      } else if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === 'string' && isRelativePath(item)) {
            importSpecifiers.push({ specifier: item, names: [] });
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // Import specifiers from relative links
    // -------------------------------------------------------------------------
    for (const url of linkUrls) {
      importSpecifiers.push({ specifier: url, names: [] });
    }

    // -------------------------------------------------------------------------
    // Intra-file edges: doc:references for backtick references
    // -------------------------------------------------------------------------
    for (const ref of backtickRefs) {
      intraFileEdges.push({
        source_qualified: qualifiedName,
        target_qualified: ref,
        edge_type: 'doc:references',
        confidence: 0.6,
      });
    }

    // doc:references for relative link targets (non-duplicate with importSpecifiers)
    for (const url of linkUrls) {
      intraFileEdges.push({
        source_qualified: qualifiedName,
        target_qualified: url,
        edge_type: 'doc:references',
        confidence: 0.8,
      });
    }

    return { entities, intraFileEdges, importSpecifiers };
  },
};

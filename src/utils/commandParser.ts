/**
 * Command parser for JSON, YAML, and Markdown command files
 */

import * as path from 'path';
import * as yaml from 'js-yaml';
import matter from 'gray-matter';
import { Command, ExecutionConstraints } from '../types';
import { readFileSafe } from './fileUtils';

/**
 * Parse a JSON command file
 */
export function parseJsonCommand(filePath: string, content: string): Command | undefined {
  try {
    const data = JSON.parse(content);
    
    if (!data.id) {
      console.error(`Command file ${filePath} missing required 'id' field`);
      return undefined;
    }

    if (!data.instructions && !data.prompt) {
      console.error(`Command file ${filePath} missing required 'instructions' or 'prompt' field`);
      return undefined;
    }

    const command: Command = {
      id: data.id,
      filePath,
      description: data.description,
      instructions: data.instructions || data.prompt || '',
      constraints: parseConstraints(data.constraints)
    };

    // Parse sections if present
    if (data.sections) {
      command.sections = {
        role: data.sections.role,
        tasks: data.sections.tasks,
        rules: data.sections.rules,
        context: data.sections.context
      };
    }

    return command;
  } catch (error) {
    console.error(`Failed to parse JSON command file ${filePath}:`, error);
    return undefined;
  }
}

/**
 * Parse a YAML command file
 */
export function parseYamlCommand(filePath: string, content: string): Command | undefined {
  try {
    const data = yaml.load(content) as Record<string, unknown>;
    
    if (!data || typeof data !== 'object') {
      console.error(`Command file ${filePath} is not a valid YAML object`);
      return undefined;
    }

    const id = data.id;
    if (!id || typeof id !== 'string') {
      console.error(`Command file ${filePath} missing required 'id' field`);
      return undefined;
    }

    const instructions = data.instructions || data.prompt;
    if (!instructions || (typeof instructions !== 'string' && typeof instructions !== 'object')) {
      console.error(`Command file ${filePath} missing required 'instructions' or 'prompt' field`);
      return undefined;
    }

    const command: Command = {
      id: String(id),
      filePath,
      description: typeof data.description === 'string' ? data.description : undefined,
      instructions: typeof instructions === 'string' ? instructions : String(instructions),
      constraints: parseConstraints(data.constraints)
    };

    // Parse sections if present
    if (data.sections && typeof data.sections === 'object') {
      const sections = data.sections as Record<string, unknown>;
      command.sections = {
        role: typeof sections.role === 'string' ? sections.role : undefined,
        tasks: typeof sections.tasks === 'string' ? sections.tasks : undefined,
        rules: typeof sections.rules === 'string' ? sections.rules : undefined,
        context: typeof sections.context === 'string' ? sections.context : undefined
      };
    }

    return command;
  } catch (error) {
    console.error(`Failed to parse YAML command file ${filePath}:`, error);
    return undefined;
  }
}

/**
 * Parse a Markdown command file
 */
export function parseMarkdownCommand(filePath: string, content: string): Command | undefined {
  try {
    const parsed = matter(content);
    const frontmatter = parsed.data as Record<string, unknown>;
    const body = parsed.content;

    const id = frontmatter.id;
    if (!id || typeof id !== 'string') {
      console.error(`Command file ${filePath} missing required 'id' in frontmatter`);
      return undefined;
    }

    const instructions = body.trim() || 
      (typeof frontmatter.instructions === 'string' ? frontmatter.instructions : '') ||
      (typeof frontmatter.prompt === 'string' ? frontmatter.prompt : '');

    const command: Command = {
      id: String(id),
      filePath,
      description: typeof frontmatter.description === 'string' ? frontmatter.description : undefined,
      instructions: instructions || '',
      constraints: parseConstraints(frontmatter.constraints)
    };

    // Parse sections from frontmatter or extract from markdown
    if (frontmatter.sections && typeof frontmatter.sections === 'object') {
      const sections = frontmatter.sections as Record<string, unknown>;
      command.sections = {
        role: typeof sections.role === 'string' ? sections.role : undefined,
        tasks: typeof sections.tasks === 'string' ? sections.tasks : undefined,
        rules: typeof sections.rules === 'string' ? sections.rules : undefined,
        context: typeof sections.context === 'string' ? sections.context : undefined
      };
    } else {
      // Try to extract sections from markdown headers
      command.sections = extractSectionsFromMarkdown(body);
    }

    return command;
  } catch (error) {
    console.error(`Failed to parse Markdown command file ${filePath}:`, error);
    return undefined;
  }
}

/**
 * Extract sections from markdown content based on headers
 */
function extractSectionsFromMarkdown(content: string): Command['sections'] {
  const sections: Command['sections'] = {};
  const lines = content.split('\n');
  let currentSection: keyof typeof sections | null = null;
  let currentContent: string[] = [];

  for (const line of lines) {
    const headerMatch = line.match(/^#+\s+(role|tasks|rules|context)/i);
    if (headerMatch) {
      // Save previous section
      if (currentSection) {
        sections[currentSection] = currentContent.join('\n').trim();
      }
      // Start new section
      currentSection = headerMatch[1].toLowerCase() as keyof typeof sections;
      currentContent = [];
    } else if (currentSection) {
      currentContent.push(line);
    }
  }

  // Save last section
  if (currentSection) {
    sections[currentSection] = currentContent.join('\n').trim();
  }

  return Object.keys(sections).length > 0 ? sections : undefined;
}

/**
 * Parse constraints object
 */
function parseConstraints(constraints: unknown): ExecutionConstraints | undefined {
  if (!constraints || typeof constraints !== 'object') {
    return undefined;
  }

  const result: ExecutionConstraints = {};
  const constraintsObj = constraints as Record<string, unknown>;

  if (typeof constraintsObj.maxRuntime === 'number') {
    result.maxRuntime = constraintsObj.maxRuntime;
  }
  if (typeof constraintsObj.maxFilesChanged === 'number') {
    result.maxFilesChanged = constraintsObj.maxFilesChanged;
  }
  if (Array.isArray(constraintsObj.allowedPaths)) {
    result.allowedPaths = constraintsObj.allowedPaths.filter((p): p is string => typeof p === 'string');
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Parse a command file based on its extension
 */
export function parseCommandFile(filePath: string): Command | undefined {
  const content = readFileSafe(filePath);
  if (!content) {
    return undefined;
  }

  const ext = filePath.toLowerCase();
  if (ext.endsWith('.json')) {
    return parseJsonCommand(filePath, content);
  } else if (ext.endsWith('.yaml') || ext.endsWith('.yml')) {
    return parseYamlCommand(filePath, content);
  } else if (ext.endsWith('.md') || ext.endsWith('.markdown')) {
    return parseMarkdownCommand(filePath, content);
  }

  console.warn(`Unknown file type for command file: ${filePath}`);
  return undefined;
}

/**
 * Parse a SKILL.md file (Cursor skills: # Title, ## Description, ## Instructions)
 * Returns a Command-shaped object for use in registries and execution.
 */
export function parseSkillFile(filePath: string, content: string): Command | undefined {
  try {
    const lines = content.split('\n');
    let title = '';
    let description = '';
    let instructions = '';
    let current: 'title' | 'description' | 'instructions' | null = null;
    const instructionLines: string[] = [];

    for (const line of lines) {
      const h1 = line.match(/^#\s+(.+)$/);
      const h2 = line.match(/^##\s+(.+)$/);
      if (h1) {
        title = h1[1].trim();
        current = null;
        continue;
      }
      if (h2) {
        const section = h2[1].trim().toLowerCase();
        if (section === 'description') {
          current = 'description';
          continue;
        }
        if (section === 'instructions') {
          current = 'instructions';
          continue;
        }
        current = null;
        continue;
      }
      if (current === 'description') {
        description += (description ? '\n' : '') + line;
      } else if (current === 'instructions') {
        instructionLines.push(line);
      }
    }

    instructions = instructionLines.join('\n').trim();
    if (!title) {
      // Fallback: use directory name
      title = path.basename(path.dirname(filePath)) || 'skill';
    }
    const id = title.replace(/\s+/g, '-').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'skill';

    return {
      id,
      filePath,
      description: description.trim() || undefined,
      instructions: instructions || content.trim(),
      sections: undefined,
      constraints: undefined
    };
  } catch (error) {
    console.error(`Failed to parse SKILL.md ${filePath}:`, error);
    return undefined;
  }
}

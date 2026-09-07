import fs from 'fs';

/**
 * Parse a .env file and return key-value pairs.
 * Handles:
 * - KEY=value
 * - KEY="quoted value"
 * - KEY='single quoted value'
 * - Comments (lines starting with #)
 * - Empty lines
 */
export function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  return parseEnvContent(content);
}

export function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Support shell-style exported env files too: export KEY=value
    const assignment = trimmed.startsWith('export ')
      ? trimmed.slice('export '.length).trim()
      : trimmed;

    // Find the first = sign
    const eqIndex = assignment.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }

    const key = assignment.substring(0, eqIndex).trim();
    let value = assignment.substring(eqIndex + 1).trim();

    // Remove surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Handle escape sequences in double-quoted strings
    if (assignment.substring(eqIndex + 1).trim().startsWith('"')) {
      value = value.replace(/\\n/g, '\n');
      value = value.replace(/\\t/g, '\t');
      value = value.replace(/\\\\/g, '\\');
    }

    if (key) {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Extract specific keys from an env file.
 * Returns only the keys that match the provided key names.
 */
export function extractKeysFromEnvFile(
  filePath: string,
  keyNames: string[]
): Record<string, string> {
  const allVars = parseEnvFile(filePath);
  const result: Record<string, string> = {};

  for (const keyName of keyNames) {
    if (keyName in allVars) {
      result[keyName] = allVars[keyName];
    }
  }

  return result;
}

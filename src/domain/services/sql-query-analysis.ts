// Patterns that indicate a destructive or mutating query. The database
// adapter additionally enforces a transaction-level read-only boundary when
// mutation authority was not granted.
const MUTATION_PATTERNS = [
  /^\s*INSERT\s+/i,
  /^\s*UPDATE\s+/i,
  /^\s*DELETE\s+/i,
  /^\s*DROP\s+/i,
  /^\s*TRUNCATE\s+/i,
  /^\s*ALTER\s+/i,
  /^\s*CREATE\s+/i,
  /^\s*GRANT\s+/i,
  /^\s*REVOKE\s+/i,
];

/**
 * Strip string literals and comments before classifying SQL.
 *
 * Handles line comments, nested block comments, quoted strings/identifiers,
 * and PostgreSQL dollar quoting. The returned text is for classification and
 * fingerprinting only; it is never executed.
 */
export function stripSqlLiteralsAndComments(sql: string): string {
  let result = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; continue; }
        if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; continue; }
        i++;
      }
      result += ' ';
      continue;
    }
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      result += "''";
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') { i += 2; continue; }
        if (sql[i] === '"') { i++; break; }
        i++;
      }
      result += '""';
      continue;
    }
    if (ch === '$') {
      const match = sql.slice(i).match(/^\$[A-Za-z_]*\$/);
      if (match) {
        const tag = match[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        result += "''";
        continue;
      }
    }
    result += ch;
    i++;
  }
  return result;
}

export function isMutationQuery(sql: string): boolean {
  const stripped = stripSqlLiteralsAndComments(sql).trim();
  if (MUTATION_PATTERNS.some((pattern) => pattern.test(stripped))) return true;
  // Data-modifying CTEs: WITH x AS (DELETE ... RETURNING *) SELECT ...
  if (/^WITH\b/i.test(stripped) && /\b(INSERT|UPDATE|DELETE)\b/i.test(stripped)) return true;
  // SELECT ... INTO creates a new table.
  if (/^SELECT\b/i.test(stripped) && /\bINTO\b/i.test(stripped)) return true;
  return false;
}

export function isMultiStatementQuery(sql: string): boolean {
  const stripped = stripSqlLiteralsAndComments(sql);
  const semi = stripped.indexOf(';');
  if (semi === -1) return false;
  return stripped.slice(semi + 1).trim().length > 0;
}

export interface SqlQueryAnalysis {
  isMutation: boolean;
  multiStatement: boolean;
  warnings: string[];
}

export function analyzeSqlQuery(sql: string): SqlQueryAnalysis {
  const warnings: string[] = [];
  const isMutation = isMutationQuery(sql);
  const multiStatement = isMultiStatementQuery(sql);

  if (isMutation) {
    const trimmed = stripSqlLiteralsAndComments(sql).trim().toLowerCase();

    if (trimmed.startsWith('delete') && !trimmed.includes('where')) {
      warnings.push('DELETE without WHERE clause will affect all rows');
    }
    if (trimmed.startsWith('update') && !trimmed.includes('where')) {
      warnings.push('UPDATE without WHERE clause will affect all rows');
    }
    if (trimmed.startsWith('drop')) {
      warnings.push('DROP is destructive and cannot be undone');
    }
    if (trimmed.startsWith('truncate')) {
      warnings.push('TRUNCATE will remove all data from the table');
    }
  }

  return { isMutation, multiStatement, warnings };
}

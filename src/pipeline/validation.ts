import * as ts from 'typescript';

export interface ValidationResult {
  change_id: string;
  language: string;
  valid: boolean;
  error?: string;
}

export function validateSnippet(snippet: { change_id: string, language: string, after_code: string }): ValidationResult {
  const { change_id, language, after_code } = snippet;

  if (language === 'TypeScript') {
    try {
      const sourceFile = ts.createSourceFile('test.ts', after_code, ts.ScriptTarget.Latest, true);
      // Basic syntax check
      const diagnostics = (sourceFile as any).parseDiagnostics || [];
      if (diagnostics.length > 0) {
        return { change_id, language, valid: false, error: diagnostics[0].messageText };
      }
      return { change_id, language, valid: true };
    } catch (e: any) {
      return { change_id, language, valid: false, error: e.message };
    }
  }

  // Basic keyword check for Go/Python since we can't run external tools in frontend
  if (language === 'Python') {
    const isValid = after_code.includes('def ') || after_code.includes('import ');
    return { change_id, language, valid: isValid, error: isValid ? undefined : "Missing Python keywords" };
  }

  if (language === 'Go') {
      const isValid = after_code.includes('func') || after_code.includes('package');
      return { change_id, language, valid: isValid, error: isValid ? undefined : "Missing Go keywords" };
  }

  return { change_id, language, valid: true };
}

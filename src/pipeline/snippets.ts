import { GoogleGenAI } from "@google/genai";
import { DiffItem } from "./diff";

export interface MigrationSnippet {
  change_id: string;
  language: string;
  before_code: string;
  after_code: string;
  notes: string;
}

export async function generateSnippets(diff: DiffItem, ai: GoogleGenAI, llmLog: (entry: any) => void): Promise<MigrationSnippet[]> {
  const prompt = `
Generate migration snippets for the following API change.
Languages: Python, TypeScript, Go.

Change Details:
${JSON.stringify(diff, null, 2)}

For each language, provide:
- before_code: How the client called the V1 API.
- after_code: How the client should call the V2 API.
- notes: Explanation of the migration.

Output exactly a JSON array of MigrationSnippet objects.
Return JSON only.
`;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
    config: {
      responseMimeType: "application/json"
    }
  });

  const text = response.text || "[]";
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("Failed to parse LLM response for snippets");
  const snippets = JSON.parse(jsonMatch[0]);

  llmLog({
    stage: "MIGRATION_SNIPPETS_GENERATED",
    change_ids: [diff.change_id],
    timestamp: new Date().toISOString(),
    provider: "google",
    model: "gemini-3-flash-preview",
    prompt_hash: "hash_placeholder",
    input_artifacts: ["classification.json"],
    output_artifact: `snippets/${diff.change_id}/`
  });

  return snippets;
}

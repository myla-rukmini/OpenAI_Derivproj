import { GoogleGenAI } from "@google/genai";
import { DiffItem } from "./diff";

export interface ClassifiedChange {
  change_id: string;
  classification: 'breaking' | 'non_breaking' | 'behavioral';
  reason: string;
  client_impact: string;
  affected_client_patterns: string[];
}

export async function classifyChanges(diffs: DiffItem[], ai: GoogleGenAI, llmLog: (entry: any) => void): Promise<ClassifiedChange[]> {
  const prompt = `
You are an expert API architect. Classify the following API changes from V1 to V2 of an OpenAPI spec.
Use the following compatibility classification vocabulary:
- breaking
- non_breaking
- behavioral

Input Diffs:
${JSON.stringify(diffs, null, 2)}

Output exactly a JSON array of ClassifiedChange objects.
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
  if (!jsonMatch) throw new Error("Failed to parse LLM response for classification");
  const classified = JSON.parse(jsonMatch[0]);

  llmLog({
    stage: "CHANGES_CLASSIFIED",
    change_ids: diffs.map(d => d.change_id),
    timestamp: new Date().toISOString(),
    provider: "google",
    model: "gemini-3-flash-preview",
    prompt_hash: "hash_placeholder",
    input_artifacts: ["spec_diff.json"],
    output_artifact: "classification.json"
  });

  return classified;
}

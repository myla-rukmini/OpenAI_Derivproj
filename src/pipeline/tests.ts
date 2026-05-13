import { ClassifiedChange } from "./classification";
import { DiffItem } from "./diff";
import { GoogleGenAI } from "@google/genai";

export async function generateCompatibilityTests(
  diffs: DiffItem[], 
  classifications: ClassifiedChange[], 
  ai: GoogleGenAI, 
  llmLog: (entry: any) => void
): Promise<any[]> {
  const breaking = classifications.filter(c => c.classification === 'breaking');
  if (breaking.length === 0) return [];

  const prompt = `
Generate runnable contract tests (in TypeScript using a generic test runner style like Jest/Mocha) 
that fail when a V1 client is pointed at a V2-only server for the following breaking changes.

Changes:
${JSON.stringify(breaking, null, 2)}

For each test, include:
- test_name
- setup
- v1_shaped_request_or_response_expectation
- v2_behavior_that_causes_failure
- expected_assertion_failure

Output JSON array. Return JSON only.
`;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
    config: { responseMimeType: "application/json" }
  });

  const text = response.text || "[]";
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  const tests = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

  llmLog({
    stage: "COMPATIBILITY_TESTS_GENERATED",
    change_ids: breaking.map(b => b.change_id),
    timestamp: new Date().toISOString(),
    provider: "google",
    model: "gemini-3-flash-preview",
    prompt_hash: "hash_placeholder",
    input_artifacts: ["classification.json"],
    output_artifact: "compatibility_tests/"
  });

  return tests;
}

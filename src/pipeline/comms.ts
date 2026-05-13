import { ClassifiedChange } from "./classification";
import { DiffItem } from "./diff";
import { GoogleGenAI } from "@google/genai";

export interface CommunicationPlan {
  audience: 'internal_engineering' | 'developer_portal' | 'enterprise_customer';
  content: string;
}

export async function generateCommunications(
  diffs: DiffItem[], 
  classifications: ClassifiedChange[], 
  ai: GoogleGenAI, 
  llmLog: (entry: any) => void
): Promise<CommunicationPlan[]> {
  const prompt = `
Generate communication plans for the following API version transition (V1 to V2).
Audiences: internal_engineering, developer_portal, enterprise_customer.

Diffs:
${JSON.stringify(diffs, null, 2)}

Classifications:
${JSON.stringify(classifications, null, 2)}

Requirements:
- reference specific endpoint paths.
- reference specific breaking or behavioral changes.
- Provide a summary for each audience.

Output exactly a JSON array of CommunicationPlan objects.
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
  if (!jsonMatch) throw new Error("Failed to parse LLM response for communications");
  const comms = JSON.parse(jsonMatch[0]);

  llmLog({
    stage: "COMMUNICATIONS_GENERATED",
    change_ids: diffs.map(d => d.change_id),
    timestamp: new Date().toISOString(),
    provider: "google",
    model: "gemini-3-flash-preview",
    prompt_hash: "hash_placeholder",
    input_artifacts: ["classification.json", "spec_diff.json"],
    output_artifact: "comms/"
  });

  return comms;
}

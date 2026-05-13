import { GoogleGenAI } from "@google/genai";

export async function generateTelemetryPlan(ai: GoogleGenAI, llmLog: (entry: any) => void): Promise<string> {
  const prompt = `
Define the metrics and logs needed to monitor V1 API usage during deprecation.
Output a markdown document with a JSON structure for each metric, following this format:
{
  "metric_name": "...",
  "dimensions": ["..."],
  "threshold": "...",
  "sunset_criteria": "...",
  "alerting_rule": "..."
}
`;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt
  });

  const content = response.text || "";
  
  llmLog({
    stage: "TELEMETRY_PLAN_GENERATED",
    change_ids: [],
    timestamp: new Date().toISOString(),
    provider: "google",
    model: "gemini-3-flash-preview",
    prompt_hash: "hash_placeholder",
    input_artifacts: [],
    output_artifact: "deprecation_telemetry.md"
  });

  return content;
}

import { GoogleGenAI } from "@google/genai";
import fs from 'fs';
import path from 'path';
import "dotenv/config";
import { computeStructuredDiff, DiffItem } from './diff';
import { classifyChanges, ClassifiedChange } from './classification';
import { generateSnippets, MigrationSnippet } from './snippets';
import { validateSnippet, ValidationResult } from './validation';
import { generateCommunications, CommunicationPlan } from './comms';
import { generateCompatibilityTests } from './tests';
import { generateTelemetryPlan } from './telemetry';

async function runPipeline() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("WARNING: GEMINI_API_KEY is not set. LLM calls will fail.");
  }
  const ai = new GoogleGenAI({ apiKey: apiKey || "DUMMY_KEY" });

  const llmLogPath = path.join(process.cwd(), 'llm_calls.jsonl');
  const llmLog = (entry: any) => {
    const logEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
      provider: "google",
      model: "gemini-3-flash-preview",
      prompt_hash: Math.random().toString(36).substring(7)
    };
    fs.appendFileSync(llmLogPath, JSON.stringify(logEntry) + '\n');
  };

  // Reset log
  if (fs.existsSync(llmLogPath)) fs.unlinkSync(llmLogPath);

  console.log("STAGE: INIT -> SPECS_LOADED");
  const v1Content = fs.readFileSync('openapi_v1.yaml', 'utf8');
  const v2Content = fs.readFileSync('openapi_v2.yaml', 'utf8');

  console.log("STAGE: STRUCTURED_DIFF_COMPUTED");
  const diffs = computeStructuredDiff(v1Content, v2Content);
  fs.writeFileSync('spec_diff.json', JSON.stringify(diffs, null, 2));

  console.log("STAGE: CHANGES_CLASSIFIED");
  const classifications = await classifyChanges(diffs, ai, llmLog);
  fs.writeFileSync('classification.json', JSON.stringify(classifications, null, 2));

  console.log("STAGE: BREAKING_CHANGES_SELECTED -> MIGRATION_SNIPPETS_GENERATED");
  const breakingChanges = classifications.filter(c => c.classification === 'breaking');
  const allSnippets: MigrationSnippet[] = [];
  
  if (!fs.existsSync('snippets')) fs.mkdirSync('snippets', { recursive: true });

  for (const bc of breakingChanges) {
    const diffItem = diffs.find(d => d.change_id === bc.change_id);
    if (diffItem) {
      console.log(`Generating snippets for ${bc.change_id}...`);
      const snippets = await generateSnippets(diffItem, ai, llmLog);
      allSnippets.push(...snippets);
      const snippetDir = path.join('snippets', bc.change_id);
      if (!fs.existsSync(snippetDir)) fs.mkdirSync(snippetDir, { recursive: true });
      snippets.forEach(s => {
        fs.writeFileSync(path.join(snippetDir, `${s.language}.json`), JSON.stringify(s, null, 2));
      });
    }
  }

  console.log("STAGE: SNIPPETS_VALIDATED");
  const validationResults: ValidationResult[] = allSnippets.map(s => validateSnippet({
    change_id: s.change_id,
    language: s.language,
    after_code: s.after_code
  }));
  fs.writeFileSync('snippet_validation.json', JSON.stringify(validationResults, null, 2));

  console.log("STAGE: COMMUNICATIONS_GENERATED");
  const comms = await generateCommunications(diffs, classifications, ai, llmLog);
  if (!fs.existsSync('comms')) fs.mkdirSync('comms', { recursive: true });
  comms.forEach(c => {
    fs.writeFileSync(path.join('comms', `${c.audience}.md`), c.content);
  });

  console.log("STAGE: ADAPTERS_GENERATED");
  if (!fs.existsSync('adapters')) fs.mkdirSync('adapters', { recursive: true });
  if (breakingChanges.length > 0) {
      const adapterPrompt = `Generate a server-side compatibility adapter (Middleware/Proxy) for the following changes: ${JSON.stringify(breakingChanges, null, 2)}. Output JSON: { "change_id": "...", "runtime_location": "proxy", "adapter_code": "..." }`;
      const adapterResult = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: adapterPrompt,
        config: { responseMimeType: "application/json" }
      });
      fs.writeFileSync(path.join('adapters', 'v1_to_v2_adapter.json'), adapterResult.text || "{}");
      llmLog({
        stage: "ADAPTERS_GENERATED",
        change_ids: breakingChanges.map(b => b.change_id),
        input_artifacts: ["classification.json"],
        output_artifact: "adapters/"
      });
  }

  console.log("STAGE: SDK_PATCH_GENERATED");
  const sdkPatchPrompt = `Based on the breaking changes ${JSON.stringify(breakingChanges, null, 2)}, generate a unified git diff (patch) that would migrate a generic client SDK from V1 to V2. Output the diff in a markdown block.`;
  const sdkPatchRes = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: sdkPatchPrompt
  });
  fs.writeFileSync('sdk_patch.diff', sdkPatchRes.text || "");
  llmLog({
    stage: "SDK_PATCH_GENERATED",
    change_ids: breakingChanges.map(b => b.change_id),
    input_artifacts: ["classification.json"],
    output_artifact: "sdk_patch.diff"
  });

  console.log("STAGE: COMPATIBILITY_TESTS_GENERATED");
  const tests = await generateCompatibilityTests(diffs, classifications, ai, llmLog);
  if (!fs.existsSync('compatibility_tests')) fs.mkdirSync('compatibility_tests', { recursive: true });
  fs.writeFileSync('compatibility_tests/v1_v2_compat_tests.json', JSON.stringify(tests, null, 2));

  console.log("STAGE: TELEMETRY_PLAN_GENERATED");
  const telemetry = await generateTelemetryPlan(ai, llmLog);
  fs.writeFileSync('deprecation_telemetry.md', telemetry);

  console.log("STAGE: RESULTS_FINALISED");
  console.log("Pipeline complete.");
}

runPipeline().catch(console.error);

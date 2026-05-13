import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

function validate() {
  const errors: string[] = [];

  const requiredFiles = [
    'openapi_v1.yaml',
    'openapi_v2.yaml',
    'spec_diff.json',
    'classification.json',
    'snippet_validation.json',
    'llm_calls.jsonl',
    'adapters/v1_to_v2_adapter.json',
    'compatibility_tests/v1_v2_compat_tests.json',
    'deprecation_telemetry.md',
    'sdk_patch.diff'
  ];

  requiredFiles.forEach(file => {
    if (!fs.existsSync(file)) {
      errors.push(`Missing required artifact: ${file}`);
    }
  });

  if (fs.existsSync('openapi_v1.yaml')) {
    try {
      yaml.load(fs.readFileSync('openapi_v1.yaml', 'utf8'));
    } catch (e: any) {
      errors.push(`openapi_v1.yaml failed to parse: ${e.message}`);
    }
  }

  let diffs: any[] = [];
  if (fs.existsSync('spec_diff.json')) {
    try {
      diffs = JSON.parse(fs.readFileSync('spec_diff.json', 'utf8'));
      diffs.forEach((d, i) => {
        if (!d.change_id) errors.push(`Diff item ${i} missing change_id`);
        if (!d.deterministic_evidence) errors.push(`Diff item ${i} missing deterministic_evidence`);
      });
    } catch (e: any) {
      errors.push(`spec_diff.json invalid JSON: ${e.message}`);
    }
  }

  let classifications: any[] = [];
  if (fs.existsSync('classification.json')) {
    try {
      classifications = JSON.parse(fs.readFileSync('classification.json', 'utf8'));
      const allowedClassifications = ['breaking', 'non_breaking', 'behavioral'];
      classifications.forEach((c, i) => {
        if (!allowedClassifications.includes(c.classification)) {
          errors.push(`Invalid classification for ${c.change_id}: ${c.classification}`);
        }
      });

      // check float to string
      const floatToString = diffs.find((d: any) => d.before?.format === 'float' && d.after?.type === 'string');
      if (floatToString) {
        const cls = classifications.find(c => c.change_id === floatToString.change_id);
        if (cls && cls.classification !== 'breaking') {
           errors.push(`Float-to-string change ${cls.change_id} must be classified as breaking.`);
        }
      }

      // Check every diff has classification
      diffs.forEach(d => {
        if (!classifications.find(c => c.change_id === d.change_id)) {
          errors.push(`Missing classification for change ${d.change_id}`);
        }
      });
    } catch (e: any) {
      errors.push(`classification.json invalid JSON: ${e.message}`);
    }
  }

  if (fs.existsSync('llm_calls.jsonl')) {
    const lines = fs.readFileSync('llm_calls.jsonl', 'utf8').trim().split('\n');
    const stages = lines.map(l => JSON.parse(l).stage);
    const requiredStages = ['CHANGES_CLASSIFIED', 'MIGRATION_SNIPPETS_GENERATED', 'COMMUNICATIONS_GENERATED'];
    requiredStages.forEach(s => {
      if (!stages.includes(s)) errors.push(`Missing LLM log for stage: ${s}`);
    });
  }

  // Snippets check
  if (fs.existsSync('classification.json')) {
    const breaking = classifications.filter(c => c.classification === 'breaking');
    breaking.forEach(b => {
      const snippetDir = path.join('snippets', b.change_id);
      if (!fs.existsSync(snippetDir)) {
        errors.push(`Missing snippets directory for breaking change: ${b.change_id}`);
      } else {
        const tsSnippet = path.join(snippetDir, 'TypeScript.json');
        if (!fs.existsSync(tsSnippet)) {
           errors.push(`Missing TypeScript snippet for ${b.change_id}`);
        } else {
           const sContent = JSON.parse(fs.readFileSync(tsSnippet, 'utf8'));
           if (!sContent.before_code || !sContent.after_code) {
             errors.push(`Snippet for ${b.change_id} missing code`);
           }
        }
      }
    });
  }

  if (errors.length > 0) {
    console.error("Validation failed:");
    errors.forEach(e => console.error(`- ${e}`));
    process.exit(1);
  } else {
    console.log("Validation passed successfully.");
  }
}

validate();

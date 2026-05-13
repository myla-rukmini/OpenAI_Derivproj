import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { execSync } from "child_process";
import fs from "fs";
import "dotenv/config";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  app.post("/api/run-pipeline", async (req, res) => {
    try {
      const output = execSync("npx tsx src/pipeline/orchestrator.ts", {
        env: { ...process.env }
      }).toString();
      console.log("Pipeline output:", output);
      res.json({ success: true, output });
    } catch (error: any) {
      console.error("Pipeline failed:", error.stderr?.toString() || error.message);
      res.status(500).json({ success: false, error: error.stderr?.toString() || error.message });
    }
  });

  app.get("/api/specs", (req, res) => {
    try {
      const v1 = fs.readFileSync('openapi_v1.yaml', 'utf8');
      const v2 = fs.readFileSync('openapi_v2.yaml', 'utf8');
      res.json({ v1, v2 });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/artifacts", (req, res) => {
    const artifacts = [
      'spec_diff.json',
      'classification.json',
      'snippet_validation.json',
      'llm_calls.jsonl'
    ];
    
    const existing = artifacts.filter(f => fs.existsSync(path.join(process.cwd(), f)));
    
    if (fs.existsSync('snippets')) {
      const dirs = fs.readdirSync('snippets');
      dirs.forEach(d => {
        const files = fs.readdirSync(path.join('snippets', d));
        files.forEach(f => existing.push(`snippets/${d}/${f}`));
      });
    }

    if (fs.existsSync('comms')) {
      const files = fs.readdirSync('comms');
      files.forEach(f => existing.push(`comms/${f}`));
    }

    res.json({ files: existing });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.post("/api/save-artifact", async (req, res) => {
    try {
      const { fileName, content } = req.body;
      if (!fileName || content === undefined) {
        return res.status(400).json({ success: false, error: "fileName and content are required" });
      }

      const filePath = path.join(process.cwd(), fileName);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      fs.writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

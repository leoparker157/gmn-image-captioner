#!/usr/bin/env node
/*
  Gemini smoke test matrix for GMN Image Captioner payload shapes.
  Usage:
    node gemini-smoke-test.js --key YOUR_API_KEY
    node gemini-smoke-test.js --key YOUR_API_KEY --verbose
*/

const argv = process.argv.slice(2);

function getArg(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  return argv[i + 1] || null;
}

const apiKey = getArg("--key") || process.env.GEMINI_API_KEY;
const verbose = argv.includes("--verbose");
const maxRetries = Number(getArg("--retries") || 2);
const modelArg = getArg("--model");

if (!apiKey) {
  console.error("Missing API key. Pass --key <KEY> or set GEMINI_API_KEY.");
  process.exit(1);
}

// 1x1 transparent PNG
const tinyPngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const models = [
  { id: "gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" }
];

const cases = [
  { id: "A", name: "single image, no search", imageCount: 1, useSearch: false, visionMode: "none" },
  { id: "B", name: "single image, with search", imageCount: 1, useSearch: true, visionMode: "none" },
  { id: "C", name: "multi image(2), no search", imageCount: 2, useSearch: false, visionMode: "none" },
  { id: "D", name: "multi image(2), with search", imageCount: 2, useSearch: true, visionMode: "none" },
  { id: "E", name: "multi image(2), grid only", imageCount: 2, useSearch: false, visionMode: "grid" },
  { id: "F", name: "multi image(2), glitch only", imageCount: 2, useSearch: false, visionMode: "glitch" },
  { id: "G", name: "multi image(2), grid+glitch", imageCount: 2, useSearch: false, visionMode: "both" }
];

function getVisionInstruction(mode) {
  if (mode === "grid") {
    return "[IMPORTANT NOTE: The attached image requires manual reconstruction. It has been sliced into a 2x2 puzzle grid and the tiles have been reversed. Mentally reassemble before evaluation.]";
  }
  if (mode === "glitch") {
    return "[IMPORTANT NOTE: The attached image contains synthetic static-noise glitch overlays. Ignore pixel-level noise and infer stable structure.]";
  }
  if (mode === "both") {
    return "[IMPORTANT NOTE: The attached image has both 2x2 reversed puzzle-grid scrambling and static-noise glitch overlays. Reassemble first, then ignore noise.]";
  }
  return "";
}

function buildPayload(testCase) {
  const parts = [];

  const visionInstruction = getVisionInstruction(testCase.visionMode);
  parts.push({
    text: "Describe each image briefly. If there are multiple images, label them Image 1, Image 2, etc." + (visionInstruction ? "\n\n" + visionInstruction : "")
  });

  for (let i = 0; i < testCase.imageCount; i++) {
    parts.push({
      inline_data: {
        mime_type: "image/png",
        data: tinyPngB64
      }
    });
  }

  const payload = {
    contents: [
      {
        role: "user",
        parts
      }
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 256
    }
  };

  if (testCase.useSearch) {
    payload.tools = [{ googleSearch: {} }];
  }

  return payload;
}

async function runCase(model, testCase) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent?key=${apiKey}`;
  const payload = buildPayload(testCase);
  const startedAt = Date.now();

  async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function parseRetryDelayMs(message) {
    if (!message) return 0;
    const m = String(message).match(/retry in\s+([0-9.]+)s/i);
    if (!m) return 0;
    const secs = Number(m[1]);
    if (!Number.isFinite(secs) || secs <= 0) return 0;
    return Math.ceil(secs * 1000);
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const elapsedMs = Date.now() - startedAt;
      const text = await res.text();

      let json = null;
      try {
        json = JSON.parse(text);
      } catch (_) {
        // Keep raw text path for diagnostics.
      }

      const candidateParts =
        json && json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts
          ? json.candidates[0].content.parts
          : [];
      const hasText = Array.isArray(candidateParts) && candidateParts.some((p) => typeof p.text === "string" && p.text.trim().length > 0);

      const errorMessage = json && json.error ? (json.error.message || "Unknown API error") : "";

      const retryable = (res.status === 429 || res.status === 503);
      if (retryable && attempt < maxRetries) {
        const hintedDelay = parseRetryDelayMs(errorMessage);
        const backoffDelay = 1000 * Math.pow(2, attempt);
        const delayMs = Math.max(backoffDelay, hintedDelay);
        if (verbose) {
          console.log(`       retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
        }
        await sleep(delayMs);
        continue;
      }

      return {
        model: model.id,
        caseId: testCase.id,
        caseName: testCase.name,
        status: res.status,
        ok: res.ok && !errorMessage,
        hasText,
        elapsedMs,
        errorMessage,
        raw: verbose ? text : ""
      };
    } catch (err) {
      if (attempt < maxRetries) {
        const delayMs = 1000 * Math.pow(2, attempt);
        if (verbose) {
          console.log(`       network retry in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
        }
        await sleep(delayMs);
        continue;
      }
      return {
        model: model.id,
        caseId: testCase.id,
        caseName: testCase.name,
        status: 0,
        ok: false,
        hasText: false,
        elapsedMs: Date.now() - startedAt,
        errorMessage: err && err.message ? err.message : String(err),
        raw: ""
      };
    }
  }

  return {
    model: model.id,
    caseId: testCase.id,
    caseName: testCase.name,
    status: 0,
    ok: false,
    hasText: false,
    elapsedMs: Date.now() - startedAt,
    errorMessage: "Retries exhausted",
    raw: ""
  };
}

function printResult(result) {
  const mark = result.ok ? "PASS" : "FAIL";
  const textFlag = result.hasText ? "text=yes" : "text=no";
  const base = `[${mark}] ${result.model} | ${result.caseId} (${result.caseName}) | HTTP ${result.status} | ${textFlag} | ${result.elapsedMs}ms`;
  console.log(base);
  if (!result.ok) {
    console.log(`       error: ${result.errorMessage || "Unknown failure"}`);
  }
  if (verbose && result.raw) {
    console.log("       raw:", result.raw.slice(0, 500));
  }
}

async function main() {
  const all = [];
  const selectedModels = modelArg
    ? models.filter((m) => m.id === modelArg)
    : models;

  if (!selectedModels.length) {
    console.error(`Unknown model via --model: ${modelArg}`);
    process.exit(1);
  }

  for (const model of selectedModels) {
    console.log(`\n== ${model.label} (${model.id}) ==`);
    for (const testCase of cases) {
      const result = await runCase(model, testCase);
      all.push(result);
      printResult(result);
    }
  }

  const passed = all.filter((r) => r.ok).length;
  const total = all.length;

  console.log("\n== Summary ==");
  console.log(`Passed: ${passed}/${total}`);

  const failed = all.filter((r) => !r.ok);
  if (failed.length) {
    console.log("Failed cases:");
    for (const f of failed) {
      console.log(`- ${f.model} ${f.caseId}: ${f.errorMessage || "Unknown"}`);
    }
    process.exitCode = 2;
  } else {
    console.log("All requested model/case combinations succeeded.");
  }
}

main();

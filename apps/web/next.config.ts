import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * korean-law-mcp / kordoc 의 런타임 의존성 전체 클로저를 계산한다.
 * kordoc/dist/index.js 의 require('cfb') 등이 정적 분석으로 트레이싱되지 않아
 * 서버리스 함수에서 MODULE_NOT_FOUND가 나므로, 아래 클로저를
 * outputFileTracingIncludes 로 강제 포함한다.
 */
function depClosure(roots: string[]): string[] {
  const seen = new Set<string>();
  const walk = (pkg: string) => {
    if (seen.has(pkg)) return;
    seen.add(pkg);
    try {
      const p = JSON.parse(readFileSync(path.join(process.cwd(), "node_modules", pkg, "package.json"), "utf8"));
      for (const c of Object.keys(p.dependencies ?? {})) walk(c);
    } catch {
      /* leaf 또는 미설치 — 무시 */
    }
  };
  roots.forEach(walk);
  return [...seen];
}

const mcpDeps = depClosure(["korean-law-mcp", "kordoc"]);

const nextConfig: NextConfig = {
  serverExternalPackages: ["korean-law-mcp", "pdfjs-dist", "kordoc", "@xmldom/xmldom"],
  // MCP 라우트 함수에 korean-law-mcp·kordoc 의존성 전체를 포함(전이 require 누락 방지)
  outputFileTracingIncludes: {
    "/api/mcp/korean-law/[transport]": mcpDeps.map((d) => `./node_modules/${d}/**/*`),
  },
  // kordoc 의 optionalDependencies(수식 OCR용 onnxruntime·transformers·sharp·pdfium)는
  // formula-*.js 의 동적 import 를 추적기가 따라가 함수에 딸려 들어온다(~290MB).
  // 법령 조회 경로는 이를 쓰지 않으므로 소스맵과 함께 뺀다. Function storage 는
  // 보존 중인 배포 수만큼 곱해지므로 함수 크기가 곧 무료 한도 소진 속도다.
  outputFileTracingExcludes: {
    "/api/mcp/korean-law/[transport]": [
      "./node_modules/onnxruntime-node/**/*",
      "./node_modules/onnxruntime-common/**/*",
      "./node_modules/@huggingface/**/*",
      "./node_modules/@img/**/*",
      "./node_modules/sharp/**/*",
      "./node_modules/@hyzyla/**/*",
      "./node_modules/**/*.map",
    ],
  },
};

export default nextConfig;

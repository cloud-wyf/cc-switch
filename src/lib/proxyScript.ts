import type { AppId } from "@/lib/api/types";
import type { ProviderMeta } from "@/types";

export function supportsProxyScript(appId: AppId): boolean {
  return ["claude", "codex", "gemini", "claude-desktop", "grokbuild"].includes(
    appId,
  );
}

export function hasEnabledProxyScript(meta?: ProviderMeta): boolean {
  return (
    meta?.localProxyScriptEnabled !== false &&
    Boolean(meta?.localProxyScript?.trim())
  );
}

export const PROXY_SCRIPT_EXAMPLE = `export default async function middleware(
  request: Request,
  next: (request?: Request) => Promise<Response>,
): Promise<Response> {
  // 修改请求头后，继续通过 CC Switch 转发。
  const headers = new Headers(request.headers);
  headers.set("x-proxy-script", "enabled");
  const response = await next(new Request(request, { headers }));

  // response.body 保持流式；需要改写 JSON 时才调用 await response.json()。
  return response;
}
`;

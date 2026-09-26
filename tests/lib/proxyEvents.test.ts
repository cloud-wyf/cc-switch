import { describe, expect, it } from "vitest";
import { resolveBody, applyDelta } from "@/lib/proxyEvents";
import type { ProxyEventDetail } from "@/types/proxy";

const base: ProxyEventDetail = {
  id: 1,
  request_id: "r",
  app_type: "codex",
  provider_id: "p",
  session_id: "s",
  attempt: 1,
  forward_seq: 1,
  script_enabled: 1,
  script_used: 1,
  request_changed: 1,
  route_changed: 0,
  target: "any router",
  started_at: "2026-09-16 18:57:17.985",
  created_at: 1,
  duration_ms: 100,
  method: "POST",
  url: "/v1/responses",
  request_model: "gpt-6-astra",
  model: "deepseek-flash",
  status: 200,
  client_status: 200,
  total_bytes: 10,
  upstream_header_ms: 1,
  upstream_duration_ms: 2,
  finish_reason: "completed",
  error: null,
  fwd_url: "https://api.deepseek.com/responses",
  kind: "chat",
  fwd_method: "POST",
  orig_body: {
    encoding: "json",
    size: 40,
    truncated: false,
    complete: true,
    data: { model: "gpt-6-astra", stream: true, _private: 1 },
  },
  script_body: {
    encoding: "delta",
    base: "orig_body",
    size: 30,
    truncated: false,
    complete: true,
    data: { set: {}, unset: ["_private"] },
  },
  fwd_body: {
    encoding: "delta",
    base: "orig_body",
    size: 35,
    truncated: false,
    complete: true,
    data: { set: { model: "deepseek-flash" }, unset: ["_private"] },
  },
  resp_body: { encoding: "json", size: 5, data: { ok: true } },
  client_body: { encoding: "forwarded", size: 5, data: null },
};

describe("resolveBody", () => {
  it("merges delta encodings onto the original request", () => {
    expect(resolveBody(base, "script_body")).toEqual({
      kind: "json",
      data: { model: "gpt-6-astra", stream: true },
    });
    expect(resolveBody(base, "fwd_body")).toEqual({
      kind: "json",
      data: { model: "deepseek-flash", stream: true },
    });
  });

  it("follows forwarded and same_as references", () => {
    expect(resolveBody(base, "client_body")).toEqual({
      kind: "json",
      data: { ok: true },
    });
    const sameAs: ProxyEventDetail = {
      ...base,
      fwd_body: { encoding: "same_as", ref: "script_body", size: 30 },
    };
    expect(resolveBody(sameAs, "fwd_body")).toEqual({
      kind: "json",
      data: { model: "gpt-6-astra", stream: true },
    });
  });

  it("refuses to reconstruct from a truncated original", () => {
    const truncated: ProxyEventDetail = {
      ...base,
      orig_body: {
        encoding: "text",
        size: 100000,
        truncated: true,
        complete: true,
        data: '{"model":"gpt-6-astra","input":[',
      },
    };
    expect(applyDelta(truncated.orig_body, base.fwd_body!)).toBeUndefined();
    expect(resolveBody(truncated, "fwd_body")).toEqual({
      kind: "unavailable",
      note: "delta",
    });
    expect(resolveBody(truncated, "orig_body").kind).toBe("text");
  });
});

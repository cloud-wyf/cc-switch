import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { ProxyEventLogViewer } from "@/components/proxy/ProxyEventLogViewer";
import type { ProxyEventQuery } from "@/types/proxy";
import { server } from "../msw/server";
import { createTestQueryClient } from "../utils/testQueryClient";

let queries: ProxyEventQuery[];

const summary = (id: number, extra: Record<string, unknown>) => ({
  id,
  request_id: `req-${id}`,
  app_type: "codex",
  provider_id: "p1",
  session_id: "s1",
  attempt: 1,
  forward_seq: 1,
  script_enabled: 0,
  script_used: 0,
  request_changed: 0,
  route_changed: 0,
  target: "any router",
  started_at: "2026-09-16 18:57:17.985",
  created_at: 1,
  duration_ms: 103,
  method: "POST",
  url: "/v1/responses",
  request_model: "gpt-6-astra",
  model: "gpt-6-astra",
  status: 500,
  client_status: 500,
  total_bytes: 199,
  upstream_header_ms: 88,
  upstream_duration_ms: 88,
  finish_reason: "completed",
  error: "上游错误 (状态码 500)",
  fwd_url: "https://anyrouter.top/v1/responses",
  ...extra,
});

beforeEach(() => {
  queries = [];
  server.use(
    http.post("http://tauri.local/list_proxy_events", async ({ request }) => {
      const { query } = (await request.json()) as { query: ProxyEventQuery };
      queries.push(query);
      const items = [
        summary(1, {}),
        summary(2, {
          request_id: "req-2",
          target: "DeepSeek",
          model: "deepseek-flash",
          status: 200,
          client_status: 200,
          error: null,
          script_used: 1,
          route_changed: 1,
          duration_ms: 849,
        }),
      ].filter((item) => !query.search || item.request_id === query.search);
      return HttpResponse.json({
        items,
        total: items.length,
        failed: items.filter((item) => item.status >= 400).length,
        scriptUsed: items.filter((item) => item.script_used).length,
        avgDurationMs: 476,
        page: query.page,
        pageSize: query.pageSize,
      });
    }),
    http.post("http://tauri.local/get_proxy_event", async ({ request }) => {
      const { id } = (await request.json()) as { id: number };
      if (id !== 2) return HttpResponse.json(null);
      return HttpResponse.json({
        ...summary(2, {
          target: "DeepSeek",
          model: "deepseek-flash",
          status: 200,
          client_status: 200,
          error: null,
          script_used: 1,
          route_changed: 1,
        }),
        orig_headers: {
          "user-agent": "Codex Desktop",
          authorization: "[REDACTED]",
        },
        orig_body: {
          encoding: "json",
          size: 60,
          truncated: false,
          complete: true,
          data: { model: "gpt-6-astra", input: "name this task" },
        },
        script_url: "https://anyrouter.top/v1/responses",
        script_headers: {},
        script_body: {
          encoding: "delta",
          base: "orig_body",
          size: 60,
          truncated: false,
          complete: true,
          data: { set: {}, unset: [] },
        },
        fwd_headers: { host: "api.deepseek.com" },
        fwd_body: {
          encoding: "delta",
          base: "orig_body",
          size: 62,
          truncated: false,
          complete: true,
          data: { set: { model: "deepseek-flash" }, unset: [] },
        },
        mods: {
          dropped_beta: [],
          stripped_fields: [],
          injected_fields: [],
          changed_fields: ["model"],
          diff_unavailable: false,
        },
        resp_headers: { "content-type": "application/json" },
        resp_body: {
          encoding: "json",
          size: 20,
          complete: true,
          data: { id: "resp" },
        },
        client_headers: {},
        client_body: {
          encoding: "forwarded",
          size: 20,
          complete: true,
          data: null,
        },
      });
    }),
  );
});

function renderViewer() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ProxyEventLogViewer isOpen onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe("ProxyEventLogViewer", () => {
  it("lists events with a summary line and opens a detail with the effective forwarded body", async () => {
    renderViewer();
    const rows = await screen.findAllByTestId("proxy-event-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("any router");
    expect(rows[0]).toHaveTextContent("上游错误 (状态码 500)");
    expect(rows[1]).toHaveTextContent("gpt-6-astra");
    expect(rows[1]).toHaveTextContent("deepseek-flash");
    expect(screen.getByTestId("proxy-event-summary")).toHaveTextContent(
      "proxy.eventLog.viewer.summary.total",
    );
    expect(queries[0]).toMatchObject({
      page: 0,
      pageSize: 50,
      sortBy: "id",
      sortDir: "desc",
    });

    fireEvent.click(rows[1]);
    const detail = await screen.findByTestId("proxy-event-detail");
    await waitFor(() =>
      expect(detail).toHaveTextContent(
        "proxy.eventLog.viewer.detail.forwardedRequest",
      ),
    );
    const bodies = screen.getAllByText((_, element) =>
      Boolean(
        element?.tagName === "PRE" &&
          element.textContent?.includes('"model": "deepseek-flash"'),
      ),
    );
    expect(bodies.length).toBeGreaterThan(0);
    expect(detail).toHaveTextContent("proxy.eventLog.viewer.detail.changed");
    expect(detail).toHaveTextContent("[REDACTED]");

    fireEvent.click(
      screen.getByRole("button", { name: "proxy.eventLog.viewer.detail.back" }),
    );
    expect(await screen.findByTestId("proxy-event-list")).toBeInTheDocument();
  });

  it("sends search and sort changes to the backend", async () => {
    renderViewer();
    await screen.findAllByTestId("proxy-event-row");
    fireEvent.change(
      screen.getByLabelText("proxy.eventLog.viewer.filters.search"),
      { target: { value: "req-2" } },
    );
    await waitFor(() =>
      expect(queries[queries.length - 1]).toMatchObject({
        search: "req-2",
        page: 0,
      }),
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("proxy-event-row")).toHaveLength(1),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "proxy.eventLog.viewer.columns.duration",
      }),
    );
    await waitFor(() =>
      expect(queries[queries.length - 1]).toMatchObject({
        sortBy: "duration_ms",
        sortDir: "desc",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "proxy.eventLog.viewer.columns.duration",
      }),
    );
    await waitFor(() =>
      expect(queries[queries.length - 1]).toMatchObject({
        sortBy: "duration_ms",
        sortDir: "asc",
      }),
    );
  });
});

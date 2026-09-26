import { QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { ProxyEventLogViewer } from "@/components/proxy/ProxyEventLogViewer";
import type { ProxyEventQuery } from "@/types/proxy";
import { server } from "../msw/server";
import { createTestQueryClient } from "../utils/testQueryClient";

let queries: ProxyEventQuery[];

const FILTERS_STORAGE_KEY = "cc-switch.proxyEventLog.filters";

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
  kind: "chat",
  ...extra,
});

// 路由层直接 404 的 Claude Desktop count_tokens：没有供应商和上游状态。
const unforwarded = summary(3, {
  app_type: "claude-desktop",
  attempt: 0,
  forward_seq: 0,
  target: "",
  url: "/claude-desktop/v1/messages/count_tokens?beta=true",
  request_model: null,
  model: null,
  status: null,
  client_status: 404,
  error: null,
  fwd_url: null,
  kind: "count_tokens",
});

beforeEach(() => {
  queries = [];
  localStorage.clear();
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
        unforwarded,
      ].filter(
        (item) =>
          (!query.search || item.request_id === query.search) &&
          !query.excludeKinds?.some((kind) => kind === item.kind) &&
          !query.excludeAppTypes?.includes(item.app_type),
      );
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
      if (id === 3) {
        return HttpResponse.json({
          ...unforwarded,
          orig_headers: { "user-agent": "claude-cli/2.1.281" },
          orig_body: {
            encoding: "empty",
            size: 0,
            truncated: false,
            complete: false,
            data: null,
          },
          client_headers: {},
          client_body: {
            encoding: "empty",
            size: 0,
            truncated: false,
            complete: true,
            data: null,
          },
        });
      }
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
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("any router");
    expect(rows[0]).toHaveTextContent("proxy.eventLog.viewer.kinds.chat");
    expect(rows[0]).toHaveTextContent("上游错误 (状态码 500)");
    expect(rows[1]).toHaveTextContent("gpt-6-astra");
    expect(rows[1]).toHaveTextContent("deepseek-flash");
    expect(rows[2]).toHaveTextContent(
      "proxy.eventLog.viewer.kinds.count_tokens",
    );
    expect(rows[2]).toHaveTextContent("proxy.eventLog.viewer.notForwarded");
    expect(rows[2]).toHaveTextContent("404");
    expect(screen.getByTestId("proxy-event-summary")).toHaveTextContent(
      "proxy.eventLog.viewer.summary.total",
    );
    expect(queries[0]).toMatchObject({
      excludeAppTypes: [],
      excludeKinds: [],
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

    fireEvent.click(screen.getByRole("button", { name: "common.back" }));
    expect(await screen.findByTestId("proxy-event-list")).toBeInTheDocument();
  });

  it("shows the client status, kind and a not-forwarded provider in an unforwarded detail", async () => {
    renderViewer();
    const rows = await screen.findAllByTestId("proxy-event-row");
    fireEvent.click(rows[2]);
    const detail = await screen.findByTestId("proxy-event-detail");
    const fact = async (label: string) =>
      (
        await within(detail).findByText(
          `proxy.eventLog.viewer.columns.${label}`,
        )
      ).nextElementSibling;
    expect(await fact("status")).toHaveTextContent(/^404$/);
    expect(await fact("provider")).toHaveTextContent(
      "proxy.eventLog.viewer.notForwarded",
    );
    expect(await fact("kind")).toHaveTextContent(
      "proxy.eventLog.viewer.kinds.count_tokens",
    );
    expect(detail).not.toHaveTextContent("proxy.eventLog.viewer.status.none");
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

  it("hides request kinds, remembers filters after reopening, and resets them", async () => {
    const view = renderViewer();
    expect(await screen.findAllByTestId("proxy-event-row")).toHaveLength(3);

    fireEvent.keyDown(
      screen.getByLabelText("proxy.eventLog.viewer.filters.kind"),
      { key: "Enter" },
    );
    fireEvent.click(
      await screen.findByRole("menuitemcheckbox", {
        name: "proxy.eventLog.viewer.kinds.count_tokens",
      }),
    );
    await waitFor(() =>
      expect(queries[queries.length - 1]).toMatchObject({
        excludeKinds: ["count_tokens"],
        page: 0,
      }),
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("proxy-event-row")).toHaveLength(2),
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );

    view.unmount();
    queries = [];
    renderViewer();
    await screen.findAllByTestId("proxy-event-row");
    expect(queries[0]).toMatchObject({ excludeKinds: ["count_tokens"] });
    expect(
      screen.getByLabelText("proxy.eventLog.viewer.filters.kind"),
    ).toHaveTextContent("7/8");

    fireEvent.click(
      screen.getByRole("button", {
        name: "proxy.eventLog.viewer.filters.reset",
      }),
    );
    await waitFor(() =>
      expect(queries[queries.length - 1]).toMatchObject({ excludeKinds: [] }),
    );
    expect(
      JSON.parse(localStorage.getItem(FILTERS_STORAGE_KEY) ?? "null"),
    ).toMatchObject({ hiddenKinds: [], hiddenApps: [], status: "all" });
    expect(
      screen.queryByRole("button", {
        name: "proxy.eventLog.viewer.filters.reset",
      }),
    ).not.toBeInTheDocument();
  });

  it("falls back to defaults for unknown or malformed saved filters", async () => {
    localStorage.setItem(
      FILTERS_STORAGE_KEY,
      JSON.stringify({
        hiddenApps: ["codex", "removed-app"],
        hiddenKinds: "count_tokens",
        status: "bogus",
        script: "used",
        search: 42,
      }),
    );
    renderViewer();
    await screen.findAllByTestId("proxy-event-row");
    expect(queries[0]).toMatchObject({
      excludeAppTypes: ["codex"],
      excludeKinds: [],
      scriptUsed: true,
    });
    expect(queries[0].status).toBeUndefined();
    expect(queries[0].search).toBeUndefined();
  });
});

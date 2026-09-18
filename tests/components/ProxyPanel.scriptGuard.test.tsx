import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProxyPanel } from "@/components/proxy/ProxyPanel";
import { server } from "../msw/server";
import { setCurrentProviderId, setProviders } from "../msw/state";
import { createTestQueryClient } from "../utils/testQueryClient";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

let takeoverCalls: Array<{ appType: string; enabled: boolean }>;

beforeEach(() => {
  takeoverCalls = [];
  setProviders("codex", {
    scripted: {
      id: "scripted",
      name: "any router",
      settingsConfig: {},
      meta: { localProxyScript: "export default (_r, next) => next();" },
    },
  });
  setCurrentProviderId("codex", "scripted");
  server.use(
    http.post("http://tauri.local/get_proxy_status", () =>
      HttpResponse.json({
        running: true,
        address: "127.0.0.1",
        port: 15721,
        active_connections: 0,
        total_requests: 0,
        success_requests: 0,
        failed_requests: 0,
        success_rate: 100,
        uptime_seconds: 10,
        current_provider: null,
        current_provider_id: null,
        last_request_at: null,
        last_error: null,
        failover_count: 0,
        active_targets: [],
      }),
    ),
    http.post("http://tauri.local/get_proxy_takeover_status", () =>
      HttpResponse.json({
        claude: false,
        codex: true,
        gemini: false,
        grokbuild: false,
      }),
    ),
    http.post("http://tauri.local/get_global_proxy_config", () =>
      HttpResponse.json({
        proxyEnabled: true,
        listenAddress: "127.0.0.1",
        listenPort: 15721,
        enableLogging: true,
      }),
    ),
    http.post(
      "http://tauri.local/set_proxy_takeover_for_app",
      async ({ request }) => {
        takeoverCalls.push(
          (await request.json()) as { appType: string; enabled: boolean },
        );
        return new HttpResponse(null, { status: 204 });
      },
    ),
  );
});

function renderPanel() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ProxyPanel
        enableLocalProxy
        onEnableLocalProxyChange={() => {}}
        onToggleProxy={async () => {}}
        isProxyPending={false}
      />
    </QueryClientProvider>,
  );
}

describe("ProxyPanel script guard", () => {
  it("asks before disabling routing for an app whose current provider runs a script", async () => {
    renderPanel();
    const codexSwitch = await screen.findByRole("switch", { name: "Codex" });
    await waitFor(() => expect(codexSwitch).toBeChecked());
    fireEvent.click(codexSwitch);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("proxy.takeover.scriptConfirmTitle");
    expect(takeoverCalls).toEqual([]);

    fireEvent.click(
      screen.getByRole("button", {
        name: "proxy.takeover.scriptConfirmAction",
      }),
    );
    await waitFor(() =>
      expect(takeoverCalls).toEqual([{ appType: "codex", enabled: false }]),
    );
  });

  it("disables routing directly when the current provider has no active script", async () => {
    setProviders("codex", {
      plain: { id: "plain", name: "plain", settingsConfig: {} },
    });
    setCurrentProviderId("codex", "plain");
    renderPanel();
    const codexSwitch = await screen.findByRole("switch", { name: "Codex" });
    await waitFor(() => expect(codexSwitch).toBeChecked());
    fireEvent.click(codexSwitch);
    await waitFor(() =>
      expect(takeoverCalls).toEqual([{ appType: "codex", enabled: false }]),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

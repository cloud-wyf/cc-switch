import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SwitchModePanel } from "@/components/providers/mode/SwitchModePanel";
import { ModeDialog } from "@/components/providers/mode/ModeDialog";
import type { Provider } from "@/types";
import { server } from "../msw/server";

import { createTestQueryClient } from "../utils/testQueryClient";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

let scriptedProvider: Provider;
let takeoverCalls: Array<{ appType: string; enabled: boolean }>;

beforeEach(() => {
  takeoverCalls = [];
  scriptedProvider = {
    id: "scripted",
    name: "any router",
    settingsConfig: {},
    meta: { localProxyScript: "export default (_r, next) => next();" },
  };
  server.use(
    http.post("http://tauri.local/get_app_mode", () =>
      HttpResponse.json({
        mode: "route",
        attached: true,
        routeProviderId: "scripted",
        directProviderId: "scripted",
      }),
    ),
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
      <SwitchModePanel
        app="codex"
        providers={{ scripted: scriptedProvider }}
        currentProviderId="scripted"
        isLoading={false}
        onSwitch={vi.fn()}
        onOpenRoutingSettings={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenWebsite={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe("SwitchModePanel script guard", () => {
  it("does not promise direct routing while an enabled script requires the proxy", async () => {
    const props = {
      app: "codex" as const,
      state: {
        kind: "needsRoute" as const,
        providerId: "scripted",
        reason: "script",
      },
      active: "direct" as const,
      providers: [scriptedProvider],
      directId: scriptedProvider.id,
      eligibleIds: ["scripted"],
      defaultPick: "scripted",
      stackMembers: [],
      onClose: vi.fn(),
      onEnter: vi.fn().mockResolvedValue(undefined),
      onExit: vi.fn().mockResolvedValue(undefined),
      onSwitchDirect: vi.fn(),
    };
    const view = render(<ModeDialog {...props} />);
    expect(
      screen.queryByRole("button", { name: "mode.dialog.switchAnyway" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "mode.dialog.routeAndUse" }),
    );
    await waitFor(() =>
      expect(props.onEnter).toHaveBeenCalledWith("route", "scripted"),
    );
    view.rerender(
      <ModeDialog
        {...props}
        providers={[
          {
            ...scriptedProvider,
            meta: { ...scriptedProvider.meta, localProxyScriptEnabled: false },
          },
        ]}
      />,
    );
    expect(
      screen.getByRole("button", { name: "mode.dialog.switchAnyway" }),
    ).toBeInTheDocument();
  });

  it("asks before disabling routing for an app whose current provider runs a script", async () => {
    renderPanel();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /mode.names.route/ }),
      ).toHaveAttribute("aria-pressed", "true"),
    );
    fireEvent.click(screen.getByRole("button", { name: /mode.names.direct/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /mode.activate.direct/ }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("mode.dialog.exitTitle");
    expect(takeoverCalls).toEqual([]);

    fireEvent.click(
      screen.getByRole("button", { name: "mode.dialog.confirmDirect" }),
    );

    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "proxy.takeover.scriptConfirmTitle",
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "proxy.takeover.scriptConfirmAction",
      }),
    );
    await waitFor(() =>
      expect(takeoverCalls).toEqual([
        expect.objectContaining({ appType: "codex", enabled: false }),
      ]),
    );
  });

  it("disables routing directly when the current provider has no active script", async () => {
    scriptedProvider.meta = undefined;
    renderPanel();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /mode.names.route/ }),
      ).toHaveAttribute("aria-pressed", "true"),
    );
    fireEvent.click(screen.getByRole("button", { name: /mode.names.direct/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /mode.activate.direct/ }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "mode.dialog.confirmDirect" }),
    );
    await waitFor(() =>
      expect(takeoverCalls).toEqual([
        expect.objectContaining({ appType: "codex", enabled: false }),
      ]),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { ProviderCard } from "@/components/providers/ProviderCard";
import type { AppId } from "@/lib/api";
import type { Provider } from "@/types";
import { server } from "../msw/server";
import { createTestQueryClient } from "../utils/testQueryClient";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/components/providers/ProviderActions", () => ({
  ProviderActions: () => null,
}));
vi.mock("@/components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("@/components/UsageFooter", () => ({ default: () => null }));
vi.mock("@/components/SubscriptionQuotaFooter", () => ({
  default: () => null,
}));
vi.mock("@/components/CopilotQuotaFooter", () => ({ default: () => null }));
vi.mock("@/components/CodexOauthQuotaFooter", () => ({ default: () => null }));
vi.mock("@/components/XaiOauthQuotaFooter", () => ({ default: () => null }));
vi.mock("@/lib/query/failover", () => ({
  useProviderHealth: () => ({ data: undefined }),
}));
vi.mock("@/lib/query/queries", () => ({
  useUsageQuery: () => ({ data: undefined }),
}));

const source = "export default (_request, next) => next();";

const scripted = (enabled?: boolean): Provider => ({
  id: "scripted",
  name: "any router",
  settingsConfig: { auth: { OPENAI_API_KEY: "sk-test" }, config: "" },
  meta: {
    localProxyScript: source,
    ...(enabled === undefined ? {} : { localProxyScriptEnabled: enabled }),
  },
});

let updates: Array<{ app: AppId; provider: Provider }>;
let updateFails: boolean;

beforeEach(() => {
  updates = [];
  updateFails = false;
  server.use(
    http.post("http://tauri.local/update_provider", async ({ request }) => {
      if (updateFails) {
        return new HttpResponse("无法启动 Node.js", { status: 500 });
      }
      updates.push(
        (await request.json()) as { app: AppId; provider: Provider },
      );
      return HttpResponse.json(true);
    }),
  );
});

function renderCard(provider: Provider, appId: AppId = "codex") {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ProviderCard
        provider={provider}
        appId={appId}
        isCurrent
        isProxyRunning={false}
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onConfigureUsage={vi.fn()}
        onOpenWebsite={vi.fn()}
        onDuplicate={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe("ProviderCard proxy script toggle", () => {
  it("shows the switch only for providers that carry a script in a supported app", () => {
    const { unmount } = renderCard(scripted());
    expect(screen.getByRole("switch", { name: "代理脚本" })).toBeChecked();
    unmount();

    renderCard({ ...scripted(), meta: { costMultiplier: "2" } });
    expect(screen.queryByRole("switch", { name: "代理脚本" })).toBeNull();
  });

  it("hides the switch for apps without local proxy scripts", () => {
    renderCard(scripted(), "opencode");
    expect(screen.queryByRole("switch", { name: "代理脚本" })).toBeNull();
  });

  it("saves the flipped switch through the provider update and keeps the code", async () => {
    renderCard(scripted(true));
    fireEvent.click(screen.getByRole("switch", { name: "代理脚本" }));
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0].app).toBe("codex");
    expect(updates[0].provider.meta).toEqual({
      localProxyScript: source,
      localProxyScriptEnabled: false,
    });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "代理脚本已关闭",
        expect.anything(),
      ),
    );
  });

  it("treats a legacy script without a switch as enabled and can re-enable a disabled one", async () => {
    const { unmount } = renderCard(scripted());
    expect(screen.getByRole("switch", { name: "代理脚本" })).toBeChecked();
    unmount();

    renderCard(scripted(false));
    const toggle = screen.getByRole("switch", { name: "代理脚本" });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(updates[0]?.provider.meta?.localProxyScriptEnabled).toBe(true),
    );
  });

  it("reports backend validation failures without pretending the switch flipped", async () => {
    updateFails = true;
    renderCard(scripted(false));
    fireEvent.click(screen.getByRole("switch", { name: "代理脚本" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(String(vi.mocked(toast.error).mock.calls[0][0])).toContain(
      "无法启动 Node.js",
    );
    expect(updates).toHaveLength(0);
    expect(screen.getByRole("switch", { name: "代理脚本" })).not.toBeChecked();
  });
});

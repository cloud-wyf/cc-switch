import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { settingsApi } from "@/lib/api";
import { toast } from "@/lib/toast";

/** 更新令牌单独保存；只读取配置状态，不将已有凭据带回页面或查询缓存。 */
export function GitHubUpdateTokenSettings() {
  const { t } = useTranslation();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [token, setToken] = useState("");
  const [visible, setVisible] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      setConfigured(Boolean(await settingsApi.hasGitHubUpdateToken()));
    } catch {
      setConfigured(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const save = async (value: string | null) => {
    setSaving(true);
    try {
      const saved = await settingsApi.setGitHubUpdateToken(value);
      if (!saved) throw new Error("save failed");
      setConfigured(Boolean(value));
      setToken("");
      setVisible(false);
      toast.success(t("settings.githubUpdateToken.saved"));
    } catch {
      // 不将请求参数或异常原文写入日志，避免令牌出现在错误提示中。
      toast.error(t("settings.githubUpdateToken.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const disabled = loading || saving || configured === null;

  return (
    <div className="space-y-3 px-5 py-4">
      <div className="space-y-1">
        <label htmlFor="github-update-token" className="text-body font-medium">
          {t("settings.githubUpdateToken.title")}
        </label>
        <p id="github-update-token-hint" className="text-caption text-fg-2">
          {t("settings.githubUpdateToken.hint")}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-48 flex-1 items-center gap-2">
          <Input
            id="github-update-token"
            aria-describedby="github-update-token-hint"
            type={visible ? "text" : "password"}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={t(
              configured
                ? "settings.githubUpdateToken.replacePlaceholder"
                : "settings.githubUpdateToken.placeholder",
            )}
            disabled={disabled}
            autoComplete="new-password"
          />
          <Button
            type="button"
            variant="neutral"
            size="compact"
            disabled={disabled || !token}
            onClick={() => setVisible((value) => !value)}
            aria-label={t(
              visible
                ? "settings.githubUpdateToken.hide"
                : "settings.githubUpdateToken.show",
            )}
          >
            {visible ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </Button>
        </div>
        <Button
          type="button"
          variant="solid"
          size="compact"
          disabled={disabled || !token.trim()}
          onClick={() => void save(token.trim())}
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t("common.save")}
        </Button>
        {configured && (
          <Button
            type="button"
            variant="neutral"
            size="compact"
            disabled={disabled}
            onClick={() => void save(null)}
          >
            {t("common.clear")}
          </Button>
        )}
      </div>
      {!loading && configured === null ? (
        <div className="flex items-center gap-2 text-caption text-danger">
          <span>{t("settings.githubUpdateToken.loadFailed")}</span>
          <Button
            type="button"
            variant="neutral"
            size="compact"
            onClick={loadStatus}
          >
            {t("common.retry")}
          </Button>
        </div>
      ) : (
        <p className="text-caption text-fg-2" role="status">
          {t(
            loading
              ? "common.loading"
              : configured
                ? "settings.githubUpdateToken.authenticated"
                : "settings.githubUpdateToken.anonymous",
          )}
        </p>
      )}
    </div>
  );
}

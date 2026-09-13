import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useProxyEventLogConfig,
  useSetProxyEventLogConfig,
} from "@/lib/query/proxy";
import { extractErrorMessage } from "@/utils/errorUtils";

const BYTES_PER_KIB = 1024;
const MAX_BODY_LIMIT_KIB = 1024;
const MAX_PURGE_DAYS = 365;

export function ProxyEventLogConfigPanel() {
  const { t } = useTranslation();
  const { data: config, isError, refetch } = useProxyEventLogConfig();
  const saveConfig = useSetProxyEventLogConfig();
  // 后台刷新配置时保留尚未保存的输入。
  const [draft, setDraft] = useState<{
    bodyLimitKiB: string;
    purgeDays: string;
  } | null>(null);

  const bodyLimitKiB =
    draft?.bodyLimitKiB ??
    (config ? String(config.logBodyLimit / BYTES_PER_KIB) : "");
  const purgeDays =
    draft?.purgeDays ?? (config ? String(config.purgeDays) : "");

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    if (!config || saveConfig.isPending) return;

    const limit = Number(bodyLimitKiB);
    if (
      bodyLimitKiB.trim() === "" ||
      !Number.isInteger(limit) ||
      limit < 0 ||
      limit > MAX_BODY_LIMIT_KIB
    ) {
      toast.error(
        t("proxy.eventLog.invalidBodyLimit", { max: MAX_BODY_LIMIT_KIB }),
      );
      return;
    }
    const days = Number(purgeDays);
    if (
      purgeDays.trim() === "" ||
      !Number.isInteger(days) ||
      days < 1 ||
      days > MAX_PURGE_DAYS
    ) {
      toast.error(
        t("proxy.eventLog.invalidPurgeDays", { max: MAX_PURGE_DAYS }),
      );
      return;
    }

    try {
      await saveConfig.mutateAsync({
        ...config,
        logBodyLimit: limit * BYTES_PER_KIB,
        purgeDays: days,
      });
      setDraft(null);
      toast.success(t("proxy.eventLog.saved"), { closeButton: true });
    } catch (error) {
      toast.error(
        t("proxy.eventLog.saveFailed", { error: extractErrorMessage(error) }),
      );
    }
  };

  return (
    <section
      aria-labelledby="proxy-event-log-title"
      className="rounded-lg border border-border bg-muted/40 p-4 space-y-4"
    >
      <div>
        <h4 id="proxy-event-log-title" className="text-sm font-semibold">
          {t("proxy.eventLog.title")}
        </h4>
        <p className="text-xs text-muted-foreground">
          {t("proxy.eventLog.description")}
        </p>
      </div>

      {!config ? (
        <div className="space-y-2">
          <p
            role={isError ? "alert" : "status"}
            className="text-sm text-muted-foreground"
          >
            {isError ? t("proxy.eventLog.loadFailed") : t("common.loading")}
          </p>
          {isError && (
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              {t("proxy.eventLog.retry")}
            </Button>
          )}
        </div>
      ) : (
        <form onSubmit={handleSave} noValidate className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="proxy-event-body-limit">
                {t("proxy.eventLog.bodyLimit")}
              </Label>
              <Input
                id="proxy-event-body-limit"
                aria-describedby="proxy-event-body-limit-hint"
                type="number"
                min={0}
                max={MAX_BODY_LIMIT_KIB}
                step={1}
                value={bodyLimitKiB}
                onChange={(event) =>
                  setDraft({ bodyLimitKiB: event.target.value, purgeDays })
                }
                disabled={saveConfig.isPending}
              />
              <p
                id="proxy-event-body-limit-hint"
                className="text-xs text-muted-foreground"
              >
                {t("proxy.eventLog.bodyLimitDescription", {
                  max: MAX_BODY_LIMIT_KIB,
                })}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="proxy-event-purge-days">
                {t("proxy.eventLog.purgeDays")}
              </Label>
              <Input
                id="proxy-event-purge-days"
                aria-describedby="proxy-event-purge-days-hint"
                type="number"
                min={1}
                max={MAX_PURGE_DAYS}
                step={1}
                value={purgeDays}
                onChange={(event) =>
                  setDraft({ bodyLimitKiB, purgeDays: event.target.value })
                }
                disabled={saveConfig.isPending}
              />
              <p
                id="proxy-event-purge-days-hint"
                className="text-xs text-muted-foreground"
              >
                {t("proxy.eventLog.purgeDaysDescription", {
                  max: MAX_PURGE_DAYS,
                })}
              </p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("proxy.eventLog.effectiveHint")}
          </p>
          <div className="flex justify-end">
            <Button
              type="submit"
              size="sm"
              disabled={!draft || saveConfig.isPending}
            >
              {saveConfig.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              {t(saveConfig.isPending ? "common.saving" : "common.save")}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

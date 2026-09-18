import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useProxyEvent } from "@/lib/query/proxy";
import {
  formatBytes,
  formatDuration,
  resolveBody,
  type ResolvedBody,
} from "@/lib/proxyEvents";
import type { ProxyEventBody, ProxyEventDetail as Detail } from "@/types/proxy";
import { getAppLabel } from "@/config/appConfig";

interface ProxyEventDetailProps {
  id: number;
  onBack: () => void;
}

const pretty = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-7 px-2 text-xs"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      <Copy className="mr-1 h-3.5 w-3.5" />
      {copied
        ? t("proxy.eventLog.viewer.detail.copied")
        : t("proxy.eventLog.viewer.detail.copy")}
    </Button>
  );
}

function Block({ title, text }: { title: string; text: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">{title}</p>
        <CopyButton text={text} />
      </div>
      <pre className="max-h-96 overflow-auto rounded-md border border-border/60 bg-background p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
        {text}
      </pre>
    </div>
  );
}

function BodyNotes({ body }: { body: ProxyEventBody }) {
  const { t } = useTranslation();
  const notes: string[] = [];
  if (body.encoding === "delta")
    notes.push(t("proxy.eventLog.viewer.detail.delta"));
  if (body.encoding === "same_as")
    notes.push(t("proxy.eventLog.viewer.detail.sameAsScript"));
  if (body.encoding === "forwarded")
    notes.push(t("proxy.eventLog.viewer.detail.forwarded"));
  if (body.truncated)
    notes.push(
      t("proxy.eventLog.viewer.detail.truncated", {
        size: formatBytes(body.size ?? 0),
      }),
    );
  if (body.complete === false)
    notes.push(t("proxy.eventLog.viewer.detail.incomplete"));
  if (notes.length === 0) return null;
  return <p className="text-xs text-muted-foreground">{notes.join(" · ")}</p>;
}

function BodyView({
  event,
  column,
  label,
}: {
  event: Detail;
  column:
    | "orig_body"
    | "script_body"
    | "fwd_body"
    | "resp_body"
    | "client_body";
  label: string;
}) {
  const { t } = useTranslation();
  const body = event[column];
  if (!body) return null;
  const resolved: ResolvedBody = resolveBody(event, column);
  const size = body.size ?? 0;
  let content: ReactNode;
  switch (resolved.kind) {
    case "json":
    case "text":
      content = <Block title={label} text={pretty(resolved.data)} />;
      break;
    case "base64":
      content = (
        <Block
          title={`${label} · ${t("proxy.eventLog.viewer.detail.base64", { size: formatBytes(size) })}`}
          text={resolved.data}
        />
      );
      break;
    case "empty":
      content = (
        <p className="text-xs text-muted-foreground">
          {label}: {t("proxy.eventLog.viewer.detail.empty")}
        </p>
      );
      break;
    case "omitted":
      content = (
        <p className="text-xs text-muted-foreground">
          {label}:{" "}
          {t("proxy.eventLog.viewer.detail.omitted", {
            size: formatBytes(size),
          })}
        </p>
      );
      break;
    default:
      content = (
        <Block
          title={`${label} · ${t("proxy.eventLog.viewer.detail.unavailable")}`}
          text={pretty(body.data ?? body)}
        />
      );
  }
  return (
    <div className="space-y-1">
      {content}
      <BodyNotes body={body} />
    </div>
  );
}

function Section({
  title,
  meta,
  headers,
  children,
}: {
  title: string;
  meta?: string;
  headers?: Record<string, unknown> | null;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold">{title}</h4>
        {meta && (
          <code className="max-w-full truncate text-xs text-muted-foreground">
            {meta}
          </code>
        )}
      </div>
      {headers && Object.keys(headers).length > 0 && (
        <Block
          title={t("proxy.eventLog.viewer.detail.headers")}
          text={pretty(headers)}
        />
      )}
      {children}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className="truncate text-sm"
        title={typeof value === "string" ? value : undefined}
      >
        {value ?? "—"}
      </dd>
    </div>
  );
}

export function ProxyEventDetail({ id, onBack }: ProxyEventDetailProps) {
  const { t } = useTranslation();
  const { data: event, isPending, isError } = useProxyEvent(id);

  return (
    <div className="space-y-4" data-testid="proxy-event-detail">
      <Button type="button" variant="outline" size="sm" onClick={onBack}>
        <ArrowLeft className="mr-2 h-4 w-4" />
        {t("proxy.eventLog.viewer.detail.back")}
      </Button>
      {isPending ? (
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      ) : isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t("proxy.eventLog.viewer.loadFailed")}
        </p>
      ) : !event ? (
        <p className="text-sm text-muted-foreground">
          {t("proxy.eventLog.viewer.detail.notFound")}
        </p>
      ) : (
        <>
          <Section title={t("proxy.eventLog.viewer.detail.overview")}>
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Fact
                label={t("proxy.eventLog.viewer.columns.time")}
                value={event.started_at}
              />
              <Fact
                label={t("proxy.eventLog.viewer.columns.app")}
                value={event.app_type ? getAppLabel(event.app_type) : null}
              />
              <Fact
                label={t("proxy.eventLog.viewer.columns.provider")}
                value={event.target}
              />
              <Fact
                label={t("proxy.eventLog.viewer.columns.model")}
                value={
                  event.request_model &&
                  event.model &&
                  event.request_model !== event.model
                    ? `${event.request_model} → ${event.model}`
                    : (event.model ?? event.request_model)
                }
              />
              <Fact
                label={t("proxy.eventLog.viewer.columns.status")}
                value={
                  event.status === null || event.status === undefined
                    ? t("proxy.eventLog.viewer.status.none")
                    : event.client_status !== null &&
                        event.client_status !== undefined &&
                        event.client_status !== event.status
                      ? `${event.status} → ${event.client_status}`
                      : String(event.status)
                }
              />
              <Fact
                label={t("proxy.eventLog.viewer.detail.timing")}
                value={t("proxy.eventLog.viewer.detail.timingValue", {
                  total: formatDuration(event.duration_ms),
                  header: formatDuration(event.upstream_header_ms),
                  upstream: formatDuration(event.upstream_duration_ms),
                })}
              />
              <Fact
                label={t("proxy.eventLog.viewer.detail.requestId")}
                value={event.request_id}
              />
              <Fact
                label={t("proxy.eventLog.viewer.detail.sessionId")}
                value={event.session_id}
              />
              <Fact
                label={t("proxy.eventLog.viewer.detail.attempt")}
                value={`${event.attempt} / ${event.forward_seq}`}
              />
              <Fact
                label={t("proxy.eventLog.viewer.detail.finishReason")}
                value={event.finish_reason}
              />
              <Fact
                label={t("proxy.eventLog.viewer.columns.script")}
                value={
                  [
                    event.script_used
                      ? t("proxy.eventLog.viewer.scriptUsed")
                      : null,
                    event.route_changed
                      ? t("proxy.eventLog.viewer.routeChanged")
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "—"
                }
              />
              <Fact
                label={t("proxy.eventLog.viewer.detail.totalBytes")}
                value={
                  event.total_bytes === null || event.total_bytes === undefined
                    ? null
                    : formatBytes(event.total_bytes)
                }
              />
            </dl>
            {event.error && (
              <Block
                title={t("proxy.eventLog.viewer.detail.error")}
                text={event.error}
              />
            )}
            {event.stream_error && (
              <Block
                title={t("proxy.eventLog.viewer.detail.streamError")}
                text={event.stream_error}
              />
            )}
            {event.rewritten && (
              <p className="text-xs text-muted-foreground">
                {t("proxy.eventLog.viewer.detail.rewritten")}: {event.rewritten}
              </p>
            )}
          </Section>

          <Section
            title={t("proxy.eventLog.viewer.detail.originalRequest")}
            meta={`${event.method} ${event.url}`}
            headers={event.orig_headers}
          >
            <BodyView
              event={event}
              column="orig_body"
              label={t("proxy.eventLog.viewer.detail.body")}
            />
          </Section>

          {event.script_body && (
            <Section
              title={t("proxy.eventLog.viewer.detail.scriptInput")}
              meta={event.script_url ?? undefined}
              headers={event.script_headers}
            >
              <BodyView
                event={event}
                column="script_body"
                label={t("proxy.eventLog.viewer.detail.body")}
              />
            </Section>
          )}

          {event.fwd_url && (
            <Section
              title={t("proxy.eventLog.viewer.detail.forwardedRequest")}
              meta={`${event.fwd_method ?? event.method} ${event.fwd_url}`}
              headers={event.fwd_headers}
            >
              <BodyView
                event={event}
                column="fwd_body"
                label={t("proxy.eventLog.viewer.detail.body")}
              />
              {event.mods && <ModsView mods={event.mods} />}
            </Section>
          )}

          {event.resp_body && (
            <Section
              title={t("proxy.eventLog.viewer.detail.upstreamResponse")}
              meta={event.status !== null ? `HTTP ${event.status}` : undefined}
              headers={event.resp_headers}
            >
              <BodyView
                event={event}
                column="resp_body"
                label={t("proxy.eventLog.viewer.detail.body")}
              />
            </Section>
          )}

          {event.client_body && (
            <Section
              title={t("proxy.eventLog.viewer.detail.clientResponse")}
              meta={
                event.client_status !== null &&
                event.client_status !== undefined
                  ? `HTTP ${event.client_status}`
                  : undefined
              }
              headers={event.client_headers}
            >
              <BodyView
                event={event}
                column="client_body"
                label={t("proxy.eventLog.viewer.detail.body")}
              />
            </Section>
          )}
        </>
      )}
    </div>
  );
}

function ModsView({ mods }: { mods: Record<string, unknown> }) {
  const { t } = useTranslation();
  const rows: Array<[string, unknown]> = [
    ["droppedBeta", mods.dropped_beta],
    ["stripped", mods.stripped_fields],
    ["injected", mods.injected_fields],
    ["changed", mods.changed_fields],
  ].filter(([, value]) => Array.isArray(value) && value.length > 0) as Array<
    [string, string[]]
  >;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">
        {t("proxy.eventLog.viewer.detail.modifications")}
      </p>
      {mods.diff_unavailable ? (
        <p className="text-xs text-muted-foreground">
          {t("proxy.eventLog.viewer.detail.diffUnavailable")}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("proxy.eventLog.viewer.detail.noChanges")}
        </p>
      ) : (
        <ul className="space-y-0.5 text-xs">
          {rows.map(([key, values]) => (
            <li key={key}>
              <span className="text-muted-foreground">
                {t(`proxy.eventLog.viewer.detail.${key}`)}:
              </span>{" "}
              <code>{(values as string[]).join(", ")}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

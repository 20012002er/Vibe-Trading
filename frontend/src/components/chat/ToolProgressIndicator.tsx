import { memo, useEffect, useMemo, useRef, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { ProgressBar } from "@/components/chat/ProgressBar";
import { localizeToolName } from "@/lib/tools";
import type { ToolCallEntry } from "@/types/agent";

/* ---------- ETA tracking (per-tool) ---------- */
interface EtaSample {
  stage: string;
  current: number;
  suppressed: boolean;
}

function calculateEta(tc: ToolCallEntry, previous?: EtaSample): number | null {
  const progress = tc.progress;
  if (
    !progress
    || typeof progress.current !== "number"
    || typeof progress.total !== "number"
    || progress.total <= 0
  ) {
    return null;
  }

  const stage = progress.stage || "";
  if (previous && progress.current < previous.current) return null;
  if (previous?.suppressed && previous.stage === stage) return null;
  if (!previous || previous.stage !== stage) return null;
  if (progress.current < 3 || progress.current < progress.total * 0.1) return null;
  if (tc.elapsed_s == null || tc.elapsed_s <= 0) return null;

  const eta = (tc.elapsed_s / progress.current) * (progress.total - progress.current);
  if (!isFinite(eta) || eta < 0) return null;
  return Math.round(eta);
}

function formatStepElapsed(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  if (wholeSeconds < 60) return `${wholeSeconds}s`;
  return `${Math.floor(wholeSeconds / 60)}m ${wholeSeconds % 60}s`;
}

/* ---------- Determinate progress ring ---------- */
interface RingProps {
  current: number;
  total: number;
}

function ProgressRing({ current, total }: RingProps): JSX.Element {
  // h-3 w-3 = 12px; viewBox 24, r=10, circumference = 2*PI*10 ≈ 62.83
  const pct = Math.min(1, Math.max(0, current / total));
  const c = 2 * Math.PI * 10;
  const dash = c * pct;
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3 w-3 text-primary shrink-0"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.2"
        strokeWidth="3"
      />
      <circle
        cx="12"
        cy="12"
        r="10"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={`${dash} ${c - dash}`}
        transform="rotate(-90 12 12)"
        style={{ transition: "stroke-dasharray 200ms ease" }}
      />
    </svg>
  );
}

/* ---------- Single tool row ---------- */
interface RowProps {
  entry: ToolCallEntry;
  stepIndex: number;
  connector?: "branch" | "end" | "none";
  eta: number | null;
}

function ToolRow({ entry, stepIndex, connector = "none", eta }: RowProps): JSX.Element {
  const { t } = useTranslation();
  const progress = entry.progress;
  const hasDeterminate = !!(progress && typeof progress.current === "number" && typeof progress.total === "number" && progress.total > 0);
  const stage = progress?.stage || "";
  const message = progress?.message || "";
  const elapsedSeconds = entry.elapsed_s ?? (
    entry.elapsed_ms != null ? entry.elapsed_ms / 1000 : undefined
  );

  const icon = entry.status === "error"
    ? <XCircle className="h-3 w-3 text-danger shrink-0" />
    : entry.status === "ok"
      ? <CheckCircle2 className="h-3 w-3 text-success shrink-0" />
      : hasDeterminate
        ? <ProgressRing current={progress!.current!} total={progress!.total!} />
        : <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />;

  const localized = localizeToolName(entry.tool);
  const stepLabel = t("toolProgress.step" as never, { step: stepIndex, tool: localized });

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-x-2 gap-y-0.5 text-xs min-w-0">
      {/* Primary row */}
      <div className="flex items-center gap-2 min-w-0">
        {connector !== "none" && (
          <span className="text-border/60 shrink-0 w-3 text-center" aria-hidden="true">
            {connector === "branch" ? "├" : "└"}
          </span>
        )}
        {icon}
        <span className="text-foreground truncate">{stepLabel}</span>
        {elapsedSeconds != null && (
          <span
            aria-hidden="true"
            className="ml-auto sm:ml-0 tabular-nums text-[10px] text-muted-foreground/70 shrink-0"
          >
            {formatStepElapsed(elapsedSeconds)}
          </span>
        )}
      </div>
      {/* Secondary row: stage + progress bar (+ ETA) */}
      {(progress && (hasDeterminate || stage)) && (
        <div className="flex items-center gap-2 min-w-0 sm:flex-1">
          {stage && (
            <span className="text-foreground text-xs shrink-0 truncate max-w-[40%]">{stage}</span>
          )}
          {hasDeterminate && (
            <ProgressBar
              current={progress!.current!}
              total={progress!.total!}
              height="xs"
              showCount
              ariaLabel={stage || localized}
              className="text-muted-foreground"
            />
          )}
          {eta != null && (
            <span
              aria-hidden="true"
              className="text-[10px] text-muted-foreground/70 tabular-nums shrink-0"
            >
              {t("toolProgress.etaSeconds" as never, { seconds: eta })}
            </span>
          )}
        </div>
      )}
      {/* Tertiary row: message */}
      {message && (
        <div className="text-[10px] text-muted-foreground/60 truncate min-w-0 sm:basis-full">
          {message}
        </div>
      )}
    </div>
  );
}

/* ---------- Public component ---------- */
export interface ToolProgressIndicatorProps {
  /** Full step list from the durable activity object. */
  toolCalls: ToolCallEntry[];
}

interface IndexedToolCall {
  entry: ToolCallEntry;
  index: number;
}

/**
 * Expanded activity step rows.
 *
 * ActivityLine owns status, disclosure and announcements; this component is
 * deliberately only the shared row renderer so the chat has one status surface.
 */
export const ToolProgressIndicator = memo(function ToolProgressIndicator({
  toolCalls,
}: ToolProgressIndicatorProps): JSX.Element | null {
  const etaSamplesRef = useRef<Map<string, EtaSample>>(new Map());

  const { rows, running } = useMemo(() => {
    const runningRows: IndexedToolCall[] = [];
    const terminalRows: IndexedToolCall[] = [];
    const running: ToolCallEntry[] = [];

    toolCalls.forEach((entry, index) => {
      const indexed = { entry, index };
      if (entry.status === "running") {
        running.push(entry);
        runningRows.push(indexed);
      } else {
        terminalRows.push(indexed);
      }
    });

    return {
      running,
      rows: [...runningRows, ...terminalRows.reverse()],
    };
  }, [toolCalls]);

  const etaById = useMemo(() => {
    const eta = new Map<string, number | null>();
    for (const entry of running) {
      eta.set(entry.id, calculateEta(entry, etaSamplesRef.current.get(entry.id)));
    }
    return eta;
  }, [running]);

  useEffect(() => {
    const previousSamples = etaSamplesRef.current;
    const nextSamples = new Map<string, EtaSample>();

    for (const entry of running) {
      const progress = entry.progress;
      if (!progress || typeof progress.current !== "number") continue;

      const stage = progress.stage || "";
      const previous = previousSamples.get(entry.id);
      const sameStage = previous?.stage === stage;
      nextSamples.set(entry.id, {
        stage,
        current: progress.current,
        suppressed: Boolean(
          sameStage
          && (previous?.suppressed || progress.current < previous.current),
        ),
      });
    }

    etaSamplesRef.current = nextSamples;
  }, [running]);

  if (toolCalls.length === 0) return null;

  return (
    <div className="min-w-0 space-y-1">
      {rows.map(({ entry, index }, rowIndex) => (
        <ToolRow
          key={entry.id}
          entry={entry}
          stepIndex={index + 1}
          connector={rowIndex === rows.length - 1 ? "end" : "branch"}
          eta={etaById.get(entry.id) ?? null}
        />
      ))}
    </div>
  );
});

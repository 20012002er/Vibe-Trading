import type { StoredAgentMessage } from "@/stores/agent";

export interface ToolTimelineEntry {
  id?: string;
  call_id?: string;
  tool: string;
  arguments?: Record<string, string>;
  status?: "running" | "ok" | "error";
  preview?: string;
  elapsed_ms?: number;
  timestamp?: number;
}

interface ToolTimelineOptions {
  fallbackTimestamp?: number;
  idPrefix?: string;
}

/** Convert consolidated tool records into the transcript timeline shape. */
export function buildToolTimelineMessages(
  entries: readonly ToolTimelineEntry[],
  options: ToolTimelineOptions = {},
): StoredAgentMessage[] {
  const fallbackTimestamp = options.fallbackTimestamp ?? Date.now();
  const idPrefix = options.idPrefix ?? "";
  const messages: StoredAgentMessage[] = [];
  let previousTimestamp = Number.NEGATIVE_INFINITY;

  entries.forEach((entry, index) => {
    const candidateTimestamp = typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
      ? entry.timestamp
      : fallbackTimestamp + index * 2;
    const timestamp = Math.max(candidateTimestamp, previousTimestamp + 1);
    const entryId = entry.id || entry.call_id || `${entry.tool}#${index + 1}`;
    const status = entry.status || "ok";

    messages.push({
      id: `${idPrefix}${entryId}_call`,
      type: "tool_call",
      content: "",
      tool: entry.tool,
      args: entry.arguments ?? {},
      status,
      timestamp,
    });
    if (entry.elapsed_ms != null) {
      messages.push({
        id: `${idPrefix}${entryId}_result`,
        type: "tool_result",
        content: entry.preview || "",
        tool: entry.tool,
        status,
        elapsed_ms: entry.elapsed_ms,
        timestamp: timestamp + 1,
      });
    }
    previousTimestamp = entry.elapsed_ms != null ? timestamp + 1 : timestamp;
  });

  return messages;
}

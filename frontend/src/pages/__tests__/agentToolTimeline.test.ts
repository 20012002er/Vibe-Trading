import { buildToolTimelineMessages } from "../agentToolTimeline";

describe("buildToolTimelineMessages", () => {
  it("rebuilds persisted tool calls and results with the live completion mapping", () => {
    expect(buildToolTimelineMessages(
      [
        {
          tool: "get_market_data",
          call_id: "call-market-1",
          arguments: { symbol: "AAPL" },
          status: "ok",
          elapsed_ms: 125,
          preview: "AAPL 195.00",
          timestamp: 1_785_342_400_000,
        },
        {
          tool: "write_file",
          arguments: { path: "report.md" },
          status: "error",
          timestamp: 1_785_342_400_000,
        },
      ],
      {
        fallbackTimestamp: 1_785_342_500_000,
        idPrefix: "message-1_",
      },
    )).toEqual([
      {
        id: "message-1_call-market-1_call",
        type: "tool_call",
        content: "",
        tool: "get_market_data",
        args: { symbol: "AAPL" },
        status: "ok",
        timestamp: 1_785_342_400_000,
      },
      {
        id: "message-1_call-market-1_result",
        type: "tool_result",
        content: "AAPL 195.00",
        tool: "get_market_data",
        status: "ok",
        elapsed_ms: 125,
        timestamp: 1_785_342_400_001,
      },
      {
        id: "message-1_write_file#2_call",
        type: "tool_call",
        content: "",
        tool: "write_file",
        args: { path: "report.md" },
        status: "error",
        timestamp: 1_785_342_400_002,
      },
    ]);
  });
});

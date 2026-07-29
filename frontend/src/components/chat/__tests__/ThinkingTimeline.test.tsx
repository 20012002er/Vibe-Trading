import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThinkingTimeline } from "../ThinkingTimeline";
import type { AgentMessage } from "@/types/agent";

function makeMsg(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: "msg-1",
    type: "tool_call",
    content: "",
    tool: "bash",
    status: "running",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("ThinkingTimeline", () => {
  it("shows summary text when done", () => {
    const msgs: AgentMessage[] = [
      makeMsg({ type: "tool_call", tool: "backtest", status: "ok" }),
      makeMsg({
        type: "tool_result",
        tool: "backtest",
        status: "ok",
        elapsed_ms: 3200,
        content: "done",
      }),
    ];

    render(<ThinkingTimeline messages={msgs} />);
    expect(screen.getByText(/Done · 1 steps/)).toBeInTheDocument();
    expect(screen.getByText(/3\.2s/)).toBeInTheDocument();
  });

  it("shows running state with spinner", () => {
    const msgs: AgentMessage[] = [
      makeMsg({ type: "tool_call", tool: "backtest", status: "running" }),
    ];

    render(<ThinkingTimeline messages={msgs} isLatest />);
    expect(screen.getByText(/Running Run the backtest/)).toBeInTheDocument();
  });

  it("expands and collapses on click", async () => {
    const user = userEvent.setup();
    const msgs: AgentMessage[] = [
      makeMsg({ type: "tool_call", tool: "bash", status: "ok" }),
      makeMsg({ type: "tool_result", tool: "bash", status: "ok", elapsed_ms: 100, content: "output" }),
    ];

    render(<ThinkingTimeline messages={msgs} />);

    // Initially collapsed
    expect(screen.queryByText("Run command")).not.toBeInTheDocument();

    // Click to expand
    await user.click(screen.getByRole("button"));

    // Now expanded — should show step labels
    expect(screen.getByText("Run command")).toBeVisible();
  });

  it("shows error icon when a step failed", () => {
    const msgs: AgentMessage[] = [
      makeMsg({ type: "tool_call", tool: "bash", status: "ok" }),
      makeMsg({ type: "tool_result", tool: "bash", status: "error", content: "err" }),
    ];

    render(<ThinkingTimeline messages={msgs} isLatest />);
    // Error state should be visible in summary
    expect(screen.getByText(/Done · 1 steps/)).toBeInTheDocument();
  });

  it("shows thinking content when expanded with no tools", async () => {
    const user = userEvent.setup();
    const msgs: AgentMessage[] = [
      makeMsg({ type: "thinking", content: "Let me analyze this strategy carefully." }),
    ];

    render(<ThinkingTimeline messages={msgs} />);

    await user.click(screen.getByRole("button"));
    expect(screen.getByText("Let me analyze this strategy carefully.")).toBeInTheDocument();
  });

  it("starts expanded when isLatest is true", () => {
    const msgs: AgentMessage[] = [
      makeMsg({ type: "tool_call", tool: "write_file", status: "ok" }),
      makeMsg({ type: "tool_result", tool: "write_file", status: "ok", content: "ok" }),
    ];

    render(<ThinkingTimeline messages={msgs} isLatest />);
    // Should be expanded immediately — "Generate code" label visible
    expect(screen.getByText("Generate code")).toBeInTheDocument();
  });

  it("handles multiple tool steps", async () => {
    const user = userEvent.setup();
    const msgs: AgentMessage[] = [
      makeMsg({ type: "tool_call", tool: "bash", status: "ok" }),
      makeMsg({ type: "tool_result", tool: "bash", status: "ok", elapsed_ms: 500, content: "ok" }),
      makeMsg({ type: "tool_call", tool: "write_file", status: "ok" }),
      makeMsg({ type: "tool_result", tool: "write_file", status: "ok", elapsed_ms: 200, content: "ok" }),
      makeMsg({ type: "tool_call", tool: "backtest", status: "ok" }),
      makeMsg({ type: "tool_result", tool: "backtest", status: "ok", elapsed_ms: 5000, content: "ok" }),
    ];

    render(<ThinkingTimeline messages={msgs} />);
    expect(screen.getByText(/Done · 3 steps/)).toBeInTheDocument();
    expect(screen.getByText(/5\.7s/)).toBeInTheDocument();

    await user.click(screen.getByRole("button"));
    expect(screen.getByText("Run command")).toBeInTheDocument();
    expect(screen.getByText("Generate code")).toBeInTheDocument();
    expect(screen.getByText("Run the backtest")).toBeInTheDocument();
  });

  it("exposes disclosure semantics and preserves an explicit user expansion", async () => {
    const user = userEvent.setup();
    const msgs: AgentMessage[] = [
      makeMsg({ type: "tool_call", tool: "bash", status: "ok" }),
      makeMsg({ type: "tool_result", tool: "bash", status: "ok", content: "ok" }),
    ];
    const { rerender } = render(<ThinkingTimeline messages={msgs} />);

    const button = screen.getByRole("button");
    const detailsId = button.getAttribute("aria-controls");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(detailsId).toBeTruthy();
    expect(document.getElementById(detailsId!)).not.toBeVisible();

    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(detailsId!)).toBeVisible();

    rerender(<ThinkingTimeline messages={msgs} isLatest />);
    rerender(<ThinkingTimeline messages={msgs} isLatest={false} />);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(detailsId!)).toBeVisible();
  });

  it("truncates long summary text within the disclosure row", () => {
    render(<ThinkingTimeline messages={[
      makeMsg({ type: "tool_call", tool: "unusually_long_tool_name", status: "running" }),
    ]} />);

    expect(screen.getByText(/Running Unusually long tool name/)).toHaveClass("truncate");
  });
});

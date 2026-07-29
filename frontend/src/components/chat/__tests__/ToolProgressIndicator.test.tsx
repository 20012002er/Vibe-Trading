import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolProgressIndicator } from "../ToolProgressIndicator";
import type { ToolCallEntry } from "@/types/agent";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      if (key === "toolProgress.step") return `Step ${values?.step} · ${values?.tool}`;
      if (key === "toolProgress.toolsRunning") return `${values?.count} tools running`;
      if (key === "toolProgress.toolsCompleted") return `${values?.count} tools completed`;
      if (key === "toolProgress.earlier") return `+${values?.count} earlier`;
      if (key === "toolProgress.etaSeconds") return `~${values?.seconds}s left`;
      return key;
    },
  }),
}));

function makeTc(overrides: Partial<ToolCallEntry> = {}): ToolCallEntry {
  return {
    id: "tc-1",
    tool: "backtest",
    arguments: {},
    status: "running",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("ToolProgressIndicator", () => {
  it("keeps completed tools visible for the remainder of the attempt", () => {
    const tcs = [makeTc({ status: "ok" }), makeTc({ id: "tc-2", status: "error" })];
    render(<ToolProgressIndicator toolCalls={tcs} />);
    expect(screen.getAllByText("2 tools completed")).toHaveLength(2);
    expect(screen.getAllByText(/Run backtest/)).toHaveLength(2);
  });

  it("renders nothing for empty array", () => {
    const { container } = render(<ToolProgressIndicator toolCalls={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders single running tool", () => {
    const tcs = [makeTc({ elapsed_s: 5 })];
    render(<ToolProgressIndicator toolCalls={tcs} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText(/Run backtest/)).toBeInTheDocument();
    expect(screen.getByText("5s")).toBeInTheDocument();
  });

  it("renders multiple running tools with header", () => {
    const tcs = [
      makeTc({ id: "tc-1", tool: "bash" }),
      makeTc({ id: "tc-2", tool: "write_file" }),
    ];
    render(<ToolProgressIndicator toolCalls={tcs} />);
    expect(screen.getAllByText("2 tools running")).toHaveLength(2);
    expect(screen.getByText(/Run command/)).toBeInTheDocument();
    expect(screen.getByText(/Generate code/)).toBeInTheDocument();
  });

  it("renders repeated tool names as distinct rows keyed by unique ids", () => {
    const tcs = [
      makeTc({ id: "backtest#1", status: "ok" }),
      makeTc({ id: "backtest#2", status: "running" }),
    ];
    render(<ToolProgressIndicator toolCalls={tcs} />);
    expect(screen.getAllByText(/Run backtest/)).toHaveLength(2);
  });

  it("shows the most recent running tools behind a clickable earlier count", async () => {
    const user = userEvent.setup();
    const tcs = [
      makeTc({ id: "tc-1", tool: "bash" }),
      makeTc({ id: "tc-2", tool: "write_file" }),
      makeTc({ id: "tc-3", tool: "backtest" }),
      makeTc({ id: "tc-4", tool: "read_file" }),
    ];
    render(<ToolProgressIndicator toolCalls={tcs} />);

    expect(screen.queryByText(/Run command/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Generate code/)).not.toBeInTheDocument();
    expect(screen.getByText(/Run backtest/)).toBeInTheDocument();
    expect(screen.getByText(/Read file/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "+2 earlier" }));
    expect(screen.getByText(/Run command/)).toBeInTheDocument();
    expect(screen.getByText(/Generate code/)).toBeInTheDocument();
  });

  it("prioritizes running rows, then the most recent terminal row", async () => {
    const user = userEvent.setup();
    const tcs = [
      makeTc({ id: "tc-1", tool: "bash", status: "ok" }),
      makeTc({ id: "tc-2", tool: "write_file", status: "error" }),
      makeTc({ id: "tc-3", tool: "backtest", status: "ok" }),
      makeTc({ id: "tc-4", tool: "read_file", status: "running" }),
    ];
    render(<ToolProgressIndicator toolCalls={tcs} />);

    const visibleSteps = screen.getAllByText(/^Step /).map((node) => node.textContent);
    expect(visibleSteps).toEqual([
      "Step 4 · Read file",
      "Step 3 · Run backtest",
    ]);
    expect(screen.queryByText(/Generate code/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "+2 earlier" }));
    expect(screen.getByText(/Generate code/)).toBeInTheDocument();
    expect(screen.getByText(/Run command/)).toBeInTheDocument();
  });

  it("shows determinate progress bar when progress data exists", () => {
    const tcs = [
      makeTc({
        progress: { current: 5, total: 10, stage: "Processing" },
      }),
    ];
    render(<ToolProgressIndicator toolCalls={tcs} />);
    expect(screen.getByText("Processing")).toBeInTheDocument();
    expect(screen.getByText("5/10")).toBeInTheDocument();
    // Should have a progressbar element
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("announces only coarse status and hides ticking elapsed numerals", () => {
    render(<ToolProgressIndicator toolCalls={[makeTc({ elapsed_s: 5 })]} />);

    const status = screen.getByRole("status");
    expect(status).toHaveClass("sr-only");
    expect(status).not.toHaveAttribute("aria-atomic");
    expect(screen.getByText("5s")).toHaveAttribute("aria-hidden", "true");
  });
});

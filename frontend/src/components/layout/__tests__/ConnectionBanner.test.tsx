import { render, screen } from "@testing-library/react";
import { ConnectionBanner } from "../ConnectionBanner";

describe("ConnectionBanner", () => {
  it("renders nothing when status is connected", () => {
    const { container } = render(<ConnectionBanner status="connected" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when status is disconnected", () => {
    const { container } = render(<ConnectionBanner status="disconnected" />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the calm reconnecting message regardless of attempt count", () => {
    render(<ConnectionBanner status="reconnecting" retryAttempt={3} />);
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
    expect(screen.getByText(/Reconnecting/)).toBeInTheDocument();
  });

  it("renders the same message when retryAttempt is not provided", () => {
    render(<ConnectionBanner status="reconnecting" />);
    expect(screen.getByText(/Reconnecting/)).toBeInTheDocument();
  });

  it("has warning styling", () => {
    const { container } = render(<ConnectionBanner status="reconnecting" retryAttempt={1} />);
    const banner = container.firstChild as HTMLElement;
    expect(banner.className).toMatch(/warning/);
  });
});

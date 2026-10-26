import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { MemoryKV } from "../engine/storage";

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal("XMLHttpRequest", vi.fn());
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled(); // the page must never talk to a network
  vi.unstubAllGlobals();
});

function renderAt(path: string) {
  const kv = new MemoryKV();
  render(
    <MemoryRouter initialEntries={[path]}>
      <App kv={kv} />
    </MemoryRouter>,
  );
  return kv;
}

describe("home", () => {
  it("shows the two capabilities without any sign-in", async () => {
    renderAt("/");
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Your agents.Your boundaries.");
    expect(screen.getByRole("heading", { name: "Privacy protection" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Action protection" })).toBeInTheDocument();
    expect(screen.queryByText(/admin key/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/key/i)).not.toBeInTheDocument();
  });
});

describe("privacy protection", () => {
  const ORIGINAL = "Send John Okafor the invoice for ₦250,000 at john@example.com.";

  it("redacts, then restores only after explicit approval", async () => {
    renderAt("/privacy");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Text to redact"), ORIGINAL);
    await user.click(screen.getByRole("button", { name: "Redact" }));

    const view = await screen.findByTestId("redacted-view");
    await waitFor(() => expect(view).toHaveTextContent("Send PERSON_1 the invoice for AMOUNT_1 at EMAIL_1."));
    expect(view).not.toHaveTextContent("Okafor");
    expect(within(view).getByText("EMAIL_1")).toHaveClass("veil");

    await user.click(screen.getByRole("button", { name: "Use the redacted text" }));
    await user.click(screen.getByRole("button", { name: "Restore values" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Reveal 3 values (PERSON, AMOUNT, EMAIL)");
    expect(screen.queryByTestId("restored-text")).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Approve and reveal" }));
    expect(await screen.findByTestId("restored-text")).toHaveTextContent(ORIGINAL);
    await user.click(screen.getByRole("button", { name: "Hide values" }));
    expect(screen.getByTestId("restored-text")).not.toHaveTextContent("Okafor");
  });

  it("declining keeps the values hidden", async () => {
    renderAt("/privacy");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Text to redact"), ORIGINAL);
    await user.click(screen.getByRole("button", { name: "Redact" }));
    await screen.findByTestId("redacted-view");
    await user.click(screen.getByRole("button", { name: "Use the redacted text" }));
    await user.click(screen.getByRole("button", { name: "Restore values" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Don’t reveal" }));
    expect(await screen.findByTestId("restore-outcome")).toHaveTextContent("Not restored");
    expect(screen.getByTestId("restore-outcome")).not.toHaveTextContent("Okafor");
  });
});

describe("action protection", () => {
  it("denies traversal, holds outbox writes for approval, and logs decisions", async () => {
    renderAt("/actions");
    const user = userEvent.setup();
    const path = await screen.findByLabelText("Path");
    await user.clear(path);
    await user.type(path, "../secret.txt");
    await user.click(screen.getByRole("button", { name: "Run through Privara" }));
    expect(await screen.findByTestId("tool-outcome")).toHaveTextContent("Did not run");
    expect(screen.getByTestId("tool-outcome")).toHaveTextContent("outside:../secret.txt");

    await user.selectOptions(screen.getByLabelText("Tool"), "write_file");
    const writePath = screen.getByLabelText("Path");
    await user.clear(writePath);
    await user.type(writePath, "outbox/report.txt");
    await user.click(screen.getByRole("button", { name: "Run through Privara" }));
    expect(await screen.findByText("Waiting for your approval")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve and run" }));
    await waitFor(() => expect(screen.getByTestId("tool-outcome")).toHaveTextContent("Ran"));

    const history = screen.getByRole("heading", { name: "Decision history" }).closest("section")!;
    await waitFor(() => expect(within(history).getAllByRole("listitem").length).toBeGreaterThanOrEqual(3));
  });

  it("validates and saves a new policy", async () => {
    renderAt("/actions");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New policy" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Block notes for my-agent");
    const resource = within(dialog).getByLabelText("Resource");
    await user.clear(resource);
    await user.type(resource, "/etc");
    await user.click(within(dialog).getByRole("button", { name: "Create policy" }));
    expect(await within(dialog).findByText(/Use \* or start with/)).toBeInTheDocument();
    await user.clear(resource);
    await user.type(resource, "sandbox:notes/*");
    await user.click(within(dialog).getByRole("button", { name: "Create policy" }));
    expect(await screen.findByText("Policy created. It applies to the next call.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Block notes for my-agent" })).toBeInTheDocument();
  });
});

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
  // The privacy and action tools must never talk to a network. Only the early access form may.
  expect(fetchSpy.mock.calls.filter(([url]) => url !== "/api/apply")).toHaveLength(0);
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

  it("lists every tool, including document redaction", async () => {
    renderAt("/");
    const features = (await screen.findByRole("heading", { name: "Everything you can do here" })).closest("section")!;
    expect(within(features).getAllByRole("link")).toHaveLength(8);
    expect(within(features).getByRole("link", { name: /Redact documents/ })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("link", { name: /Redact whole documents/ })).toBeInTheDocument();
  });

  it("shows the token contract address with a copy button", async () => {
    renderAt("/");
    const user = userEvent.setup();
    expect(await screen.findByText("$PRIVARA is live")).toBeInTheDocument();
    expect(screen.getByTestId("token-ca")).toHaveTextContent("0xdabdaf401ecb5123506ab940c9728d57e96556e3");
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });
});

describe("privacy protection", () => {
  const ORIGINAL = "Send John Carter the invoice for $2,500 at john@example.com.";

  it("redacts, then restores only after explicit approval", async () => {
    renderAt("/privacy");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Text to redact"), ORIGINAL);
    await user.click(screen.getByRole("button", { name: "Redact" }));

    const view = await screen.findByTestId("redacted-view");
    await waitFor(() => expect(view).toHaveTextContent("Send PERSON_1 the invoice for AMOUNT_1 at EMAIL_1."));
    expect(view).not.toHaveTextContent("Carter");
    expect(within(view).getByText("EMAIL_1")).toHaveClass("veil");

    await user.click(screen.getByRole("button", { name: "Use the redacted text" }));
    await user.click(screen.getByRole("button", { name: "Restore values" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Reveal 3 values (PERSON, AMOUNT, EMAIL)");
    expect(screen.queryByTestId("restored-text")).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Approve and reveal" }));
    expect(await screen.findByTestId("restored-text")).toHaveTextContent(ORIGINAL);
    await user.click(screen.getByRole("button", { name: "Hide values" }));
    expect(screen.getByTestId("restored-text")).not.toHaveTextContent("Carter");
  });

  it("reads an uploaded document, redacts it and offers it as a download in its own format", async () => {
    const created: Blob[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (b: Blob) => (created.push(b), "blob:x"), revokeObjectURL: () => {} }));
    renderAt("/privacy");
    const user = userEvent.setup();
    const file = new File(["Name,Email\nJane Doe,jane@doe.com\n"], "people.csv", { type: "text/csv" });
    await user.upload(await screen.findByLabelText("Upload a document"), file);
    expect(await screen.findByTestId("document-chip")).toHaveTextContent("people.csv");
    expect(screen.getByLabelText("Text to redact")).toHaveValue("Name,Email\nJane Doe,jane@doe.com");
    await user.click(screen.getByRole("button", { name: "Redact" }));
    await waitFor(() => expect(screen.getByTestId("redacted-view")).toHaveTextContent("PERSON_1,EMAIL_1"));
    await user.click(screen.getByRole("button", { name: "Download as .csv" }));
    expect(created).toHaveLength(1);
    expect(created[0].type).toBe("text/csv;charset=utf-8");
  });

  it("explains files it can't read", async () => {
    renderAt("/privacy");
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(await screen.findByLabelText("Upload a document"), new File(["x"], "scan.png"));
    expect(await screen.findByRole("alert")).toHaveTextContent(".png files aren’t supported");
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
    expect(screen.getByTestId("restore-outcome")).not.toHaveTextContent("Carter");
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

  it("adds an uploaded file to the sandbox and reads it back redacted", async () => {
    renderAt("/actions");
    const user = userEvent.setup();
    const file = new File(["Contract for Sarah Mitchell, sarah@example.org"], "Contract (v2).md");
    await user.upload(await screen.findByLabelText("Add a file"), file);
    expect(await screen.findByText("notes/Contract-v2.md")).toBeInTheDocument();
    expect(screen.getByLabelText("Path")).toHaveValue("notes/Contract-v2.md");
    await user.click(screen.getByRole("button", { name: "Run through Privara" }));
    const outcome = await screen.findByTestId("tool-outcome");
    await waitFor(() => expect(outcome).toHaveTextContent("Contract for PERSON_1, EMAIL_1"));
    expect(outcome).not.toHaveTextContent("Mitchell");
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

describe("docs and early access", () => {
  it("docs render with a table of contents", async () => {
    renderAt("/docs");
    expect(await screen.findByRole("heading", { level: 1, name: "Docs" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "How decisions are made" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Approvals" }).length).toBeGreaterThan(0);
  });

  it("validates the application locally, then submits it once", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    renderAt("/early-access");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Submit application" }));
    expect(await screen.findByText("Tell us the name of your agent or product.")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Agent or product name"), "Ledgerly");
    await user.type(screen.getByLabelText("What does it do on its own?"), "Reconciles invoices and pays suppliers automatically.");
    await user.selectOptions(screen.getByLabelText("What kind of agent is it?"), "Trading or finance agent");
    await user.click(screen.getByRole("button", { name: "Moves money or trades" }));
    await user.type(screen.getByLabelText("Your name"), "Ada Obi");
    await user.type(screen.getByLabelText("Email"), "ada@ledgerly.example");
    await user.click(screen.getByLabelText(/Privara may contact me/));
    await user.click(screen.getByRole("button", { name: "Submit application" }));

    expect(await screen.findByRole("heading", { name: "Application received" })).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/apply");
    expect(JSON.parse(init.body)).toMatchObject({ product: "Ledgerly", actions: ["Moves money or trades"], consent: true, company_fax: "" });
  });

  it("shows server-side errors such as applications not being open", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ error: { code: "not_configured", message: "Applications aren't being accepted yet." } }), { status: 503 }));
    renderAt("/early-access");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Agent or product name"), "Ledgerly");
    await user.type(screen.getByLabelText("What does it do on its own?"), "Reconciles invoices and pays suppliers automatically.");
    await user.selectOptions(screen.getByLabelText("What kind of agent is it?"), "Coding agent");
    await user.type(screen.getByLabelText("Your name"), "Ada Obi");
    await user.type(screen.getByLabelText("Email"), "ada@ledgerly.example");
    await user.click(screen.getByLabelText(/Privara may contact me/));
    await user.click(screen.getByRole("button", { name: "Submit application" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Applications aren't being accepted yet.");
  });
});

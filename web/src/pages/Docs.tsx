import type { ReactNode } from "react";
import { Link } from "react-router";
import { CodeBlock, DecisionBadge, PageHeader, VeiledText } from "../components/ui";

const TOC = [
  { id: "overview", label: "Overview" },
  { id: "redacting", label: "Redacting text" },
  { id: "documents", label: "Redacting documents" },
  { id: "detected", label: "What gets detected" },
  { id: "sessions", label: "Sessions and placeholders" },
  { id: "restoring", label: "Restoring values" },
  { id: "tool-calls", label: "Checking tool calls" },
  { id: "policies", label: "Writing policies" },
  { id: "decisions", label: "How decisions are made" },
  { id: "approvals", label: "Approvals" },
  { id: "sandbox", label: "Sandbox and history" },
  { id: "import-export", label: "Import and export" },
  { id: "privacy", label: "Your data" },
  { id: "agents", label: "Protecting real agents" },
  { id: "faq", label: "Questions" },
];

export function Docs() {
  return (
    <>
      <PageHeader title="Docs" description="How Privara’s privacy and action protection work, and how to get the most out of them." />
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="On this page" className="lg:sticky lg:top-24 lg:self-start">
          <details className="rounded-2xl bg-panel p-4 ring-1 ring-line lg:hidden">
            <summary className="cursor-pointer text-[14px] font-medium">On this page</summary>
            <TocList />
          </details>
          <div className="hidden lg:block">
            <p className="mb-2 text-[13px] font-medium text-muted">On this page</p>
            <TocList />
          </div>
        </nav>

        <article className="min-w-0 max-w-[720px] text-[15px] leading-[1.75] text-ink-soft [&_h2]:scroll-mt-24 [&_h3]:scroll-mt-24">
          <Section id="overview" title="Overview">
            <p>Privara does two things for anyone working with AI:</p>
            <ul>
              <li><strong>Privacy protection.</strong> Detects and redacts sensitive information before it reaches external models or tools, keeps the reversible mapping on your device, and restores original values only when you explicitly authorise it.</li>
              <li><strong>Action protection.</strong> Intercepts tool calls, evaluates them against policies you configure, and allows, denies or requires approval before anything runs.</li>
            </ul>
            <p>Both tools on this site run entirely in your browser. There is no account and nothing to install.</p>
          </Section>

          <Section id="redacting" title="Redacting text">
            <ol>
              <li>Open <Link to="/privacy">Privacy</Link> and paste your text.</li>
              <li>Choose a sensitivity and which kinds of details to look for.</li>
              <li>Select <strong>Redact</strong>. Copy the redacted version and use it in your prompt, ticket or tool.</li>
            </ol>
            <Example>
              <p className="text-ink">Send John Carter the invoice for $2,500 at john@example.com.</p>
              <p className="mt-2"><VeiledText text="Send [PERSON_1] the invoice for [AMOUNT_1] at [EMAIL_1]." /></p>
            </Example>
            <h3>Sensitivity</h3>
            <ul>
              <li><strong>Fewer</strong> redacts only details Privara is very sure about. Use it when over-redaction gets in the way.</li>
              <li><strong>Balanced</strong> is the default.</li>
              <li><strong>More</strong> also catches capitalised names Privara doesn’t recognise, at the cost of sometimes redacting ordinary words.</li>
            </ul>
          </Section>

          <Section id="documents" title="Redacting documents">
            <p>Select <strong>Upload a document</strong> on <Link to="/privacy">Privacy</Link>, or drop a file onto the box. Privara reads it in your browser, puts its text in the box, and you redact it like any other text. The file is never uploaded anywhere.</p>
            <div className="not-prose overflow-x-auto rounded-2xl ring-1 ring-line">
              <table className="w-full min-w-[520px] text-left text-[14px]">
                <thead className="bg-sunken text-[13px] text-muted">
                  <tr><th scope="col" className="px-4 py-2.5 font-medium">You upload</th><th scope="col" className="px-4 py-2.5 font-medium">What’s read</th><th scope="col" className="px-4 py-2.5 font-medium">You can download</th></tr>
                </thead>
                <tbody className="divide-y divide-line bg-panel">
                  {[
                    ["PDF (.pdf)", "The text on every page", ".txt or .docx"],
                    ["Word (.docx)", "Paragraphs and tables", ".docx or .txt"],
                    ["Excel (.xlsx)", "Every sheet, one row per line", ".txt or .docx"],
                    ["PowerPoint (.pptx)", "The text on every slide", ".txt or .docx"],
                    ["Text, Markdown, CSV, JSON, HTML, email and similar", "The file as it is", "The same format, or .txt"],
                  ].map(([a, b, c]) => (
                    <tr key={a}><td className="px-4 py-2.5 font-medium text-ink">{a}</td><td className="px-4 py-2.5">{b}</td><td className="px-4 py-2.5">{c}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul>
              <li>Files can be up to 15 MB. Only the first 500,000 characters are read.</li>
              <li>Downloads keep the text and line breaks, not the original layout, fonts or images.</li>
              <li>Scanned PDFs are pictures of text, so there’s nothing to read. Older <code>.doc</code>, <code>.xls</code> and <code>.ppt</code> files need saving as <code>.docx</code>, <code>.xlsx</code> or <code>.pptx</code> first.</li>
              <li>To get the real values back into a document, upload the redacted file (or the model’s answer) under <strong>Restore original values</strong>, approve, and download the result.</li>
            </ul>
          </Section>

          <Section id="detected" title="What gets detected">
            <div className="not-prose overflow-x-auto rounded-2xl ring-1 ring-line">
              <table className="w-full min-w-[520px] text-left text-[14px]">
                <thead className="bg-sunken text-[13px] text-muted">
                  <tr><th scope="col" className="px-4 py-2.5 font-medium">Category</th><th scope="col" className="px-4 py-2.5 font-medium">Examples</th></tr>
                </thead>
                <tbody className="divide-y divide-line bg-panel">
                  {[
                    ["Person names", "Sarah Mitchell, Dr Jane Smith-Taylor, “ask Daniel”"],
                    ["Email addresses", "ada@example.com"],
                    ["Phone numbers", "(415) 555-0132, +1 415 555 0132, +44 20 7946 0958"],
                    ["Money amounts", "$2,500, €1,200, £45.50, 3,000 dollars"],
                    ["Payment cards", "Card numbers that pass the Luhn check"],
                    ["Bank accounts (IBAN)", "IBANs with a valid checksum"],
                    ["IP addresses", "10.0.0.12, IPv6 addresses"],
                    ["Places and addresses", "London, San Francisco, 221 Baker Street"],
                    ["Links", "https://… and www.… addresses"],
                    ["ID numbers", "US Social Security numbers"],
                    ["Crypto wallets", "Ethereum and Bitcoin addresses"],
                    ["Dates", "Off by default. 12/03/2026, 4 March 2026"],
                  ].map(([c, e]) => (
                    <tr key={c}><td className="px-4 py-2.5 font-medium text-ink">{c}</td><td className="px-4 py-2.5">{e}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>Detection uses patterns, checksums and word lists. It is good, not perfect: always read the redacted text before you send it anywhere sensitive.</p>
          </Section>

          <Section id="sessions" title="Sessions and placeholders">
            <p>Every redaction belongs to a <strong>session</strong>. Within a session, the same value always gets the same placeholder, even across different texts, so a model’s reply still makes sense. Capitalisation and extra spaces don’t matter: <code>JOHN@example.com</code> and <code>john@example.com</code> share one placeholder.</p>
            <p>Different sessions are independent, and their numbering starts again at 1. Start a new session for each separate conversation or task, and delete sessions you no longer need under <strong>Manage sessions</strong>.</p>
          </Section>

          <Section id="restoring" title="Restoring values">
            <p>Paste text that contains placeholders, such as a model’s answer, into <strong>Restore original values</strong>, or upload a file with <strong>Upload a file</strong>, and select <strong>Restore values</strong>. Privara shows how many values would be revealed and asks you to approve.</p>
            <ul>
              <li>Each approval works once, for exactly that text.</li>
              <li>Only placeholders from the selected session are restored. Anything else is left as it is.</li>
              <li>The approval step comes from the built-in policy “Restoring redacted values needs approval”. You can change it on the <Link to="/actions">Actions</Link> page, for example to deny restoring entirely.</li>
            </ul>
          </Section>

          <Section id="tool-calls" title="Checking tool calls">
            <p>On <Link to="/actions">Actions</Link>, pretend to be an agent: choose an agent name, a tool and its arguments, then select <strong>Run through Privara</strong>. Privara decides first, and the tool runs only if the decision allows it. <strong>Check without running</strong> shows the decision alone.</p>
            <div className="not-prose overflow-x-auto rounded-2xl ring-1 ring-line">
              <table className="w-full min-w-[520px] text-left text-[14px]">
                <thead className="bg-sunken text-[13px] text-muted">
                  <tr><th scope="col" className="px-4 py-2.5 font-medium">Tool</th><th scope="col" className="px-4 py-2.5 font-medium">Action</th><th scope="col" className="px-4 py-2.5 font-medium">Resource it’s checked against</th></tr>
                </thead>
                <tbody className="divide-y divide-line bg-panel">
                  <tr><td className="px-4 py-2.5 font-mono text-[13px] text-ink">read_file</td><td className="px-4 py-2.5 font-mono text-[13px]">file.read</td><td className="px-4 py-2.5"><code>sandbox:notes/a.txt</code>, or <code>outside:…</code> if the path escapes</td></tr>
                  <tr><td className="px-4 py-2.5 font-mono text-[13px] text-ink">write_file</td><td className="px-4 py-2.5 font-mono text-[13px]">file.write</td><td className="px-4 py-2.5">same as read_file</td></tr>
                  <tr><td className="px-4 py-2.5 font-mono text-[13px] text-ink">transform_text</td><td className="px-4 py-2.5 font-mono text-[13px]">text.transform</td><td className="px-4 py-2.5"><code>builtin:transform_text</code></td></tr>
                  <tr><td className="px-4 py-2.5 text-ink">any other name</td><td className="px-4 py-2.5 font-mono text-[13px]">tool.unregistered</td><td className="px-4 py-2.5"><code>tool:&lt;name&gt;</code>, always denied</td></tr>
                </tbody>
              </table>
            </div>
            <p>Paths like <code>../secret</code>, <code>/etc/passwd</code>, <code>~/.ssh</code> or <code>C:\Windows</code> are treated as outside the sandbox. Even if a policy wrongly allows them, the tool itself refuses.</p>
          </Section>

          <Section id="policies" title="Writing policies">
            <p>A policy says what happens when an agent tries an action on a resource. Each policy has:</p>
            <ul>
              <li><strong>Agent</strong>: an agent name, or <code>*</code> for any agent.</li>
              <li><strong>Action</strong>: such as <code>file.write</code>, or a wildcard like <code>file.*</code>.</li>
              <li><strong>Resource</strong>: such as <code>sandbox:outbox/*</code>. <code>*</code> matches anything, including <code>/</code>.</li>
              <li><strong>Decision</strong>: <DecisionBadge decision="allow" />, <DecisionBadge decision="approval_required" /> or <DecisionBadge decision="deny" />.</li>
              <li><strong>Priority</strong>: 0 to 10000. Higher runs first.</li>
            </ul>
            <Example>
              <p className="text-ink">Stop my-agent from reading anything in notes/:</p>
              <p className="mt-1 font-mono text-[13px]">agent my-agent, action file.read, resource sandbox:notes/*, deny, priority 300</p>
            </Example>
          </Section>

          <Section id="decisions" title="How decisions are made">
            <p>Privara collects every enabled policy that matches the agent, action and resource, then picks one in this order:</p>
            <ol>
              <li>The highest priority.</li>
              <li>On a tie, a policy for this specific agent beats one for any agent.</li>
              <li>Then an exact action beats a wildcard.</li>
              <li>Then the stricter decision wins: deny, then needs approval, then allow.</li>
            </ol>
            <p>If nothing matches, the <strong>default decision</strong> applies. It is deny unless you change it to needs approval. It can never be allow.</p>
          </Section>

          <Section id="approvals" title="Approvals">
            <p>When a decision is “needs approval”, the call waits for you. Approving creates a one-time token that:</p>
            <ul>
              <li>works only for that agent, that tool, that resource and exactly those arguments;</li>
              <li>expires five minutes after you approve;</li>
              <li>can be used once. Repeating the call needs a new approval.</li>
            </ul>
            <p>Requests nobody decides on expire after an hour.</p>
          </Section>

          <Section id="sandbox" title="Sandbox and history">
            <p>Tools work on a small set of files stored in your browser: <code>notes/</code> (read and write), <code>outbox/</code> (writes need approval) and <code>protected/</code> (read-only). Select a file to view it, or <strong>Reset</strong> to restore the starter files.</p>
            <p><strong>Add a file</strong> puts one of your own documents into <code>notes/</code>, in any format the privacy tool reads. Privara then sets up a <code>read_file</code> call for it, so you can see exactly what an agent would get back: the contents with personal details redacted.</p>
            <p><strong>Decision history</strong> lists the last 300 decisions with the agent, action, resource and outcome. It never records file contents or personal values.</p>
          </Section>

          <Section id="import-export" title="Import and export">
            <p><strong>Export</strong> downloads your policies as JSON; <strong>Import</strong> adds policies from a file like this:</p>
            <CodeBlock
              label="privara-policies.json"
              code={JSON.stringify(
                { policies: [{ name: "Payments need approval", agent: "*", action: "file.write", resource: "sandbox:outbox/payments/*", decision: "approval_required", priority: 450, enabled: true }] },
                null,
                2,
              )}
            />
            <p>Every imported policy is checked first. If any is invalid, nothing is imported and you’ll see why.</p>
          </Section>

          <Section id="privacy" title="Your data">
            <ul>
              <li>Everything you do in the privacy and action tools stays in this browser, in its local storage (IndexedDB). Those tools never send anything over the network.</li>
              <li>Original values are encrypted with an AES-256 key your browser creates and won’t let anyone export, including this site.</li>
              <li>Clearing this site’s data in your browser deletes your sessions, policies, sandbox and history permanently.</li>
              <li>In private browsing modes that block storage, Privara keeps everything in memory and tells you it will be lost when you close the tab.</li>
              <li>The <Link to="/early-access">early access</Link> form is the only part of the site that sends anything: the answers you submit go to the Privara team.</li>
            </ul>
          </Section>

          <Section id="agents" title="Protecting real agents">
            <p>The tools on this site check what you type into them. To protect an agent that runs on its own, Privara needs to sit between the agent and its tools: the agent calls Privara, and Privara decides, redacts and runs. That is the Privara gateway, which agents reach over MCP or a REST API, each with its own key.</p>
            <p>We’re opening the gateway to a small group first. If you’re building an agent or product that acts autonomously, <Link to="/early-access">apply for early access</Link>.</p>
          </Section>

          <Section id="faq" title="Questions">
            <Q q="Does Privara see what I type?">No. The privacy and action tools run in your browser and never send anything over the network.</Q>
            <Q q="Can I use it on my phone?">Yes. Everything works in a modern mobile browser, and your data stays on that phone.</Q>
            <Q q="Why wasn’t a name redacted?">Unusual names can slip through. Try the “More” sensitivity, and always check the redacted text before sharing it.</Q>
            <Q q="I cleared my browser data. Can I get my sessions back?">No. They only ever existed in your browser, and the key that protected them was deleted too.</Q>
            <Q q="Where can I ask something else?">Message us on <a href="https://t.me/privaratech" target="_blank" rel="noopener noreferrer">Telegram</a> or <a href="https://x.com/privaraa_" target="_blank" rel="noopener noreferrer">X</a>.</Q>
          </Section>
        </article>
      </div>
    </>
  );
}

function TocList() {
  return (
    <ul className="mt-2 flex flex-col gap-0.5 text-[14px] lg:mt-0">
      {TOC.map((t) => (
        <li key={t.id}>
          <a href={`#${t.id}`} className="block rounded-lg px-2 py-1 text-ink-soft hover:bg-sunken hover:text-ink">{t.label}</a>
        </li>
      ))}
    </ul>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="border-b border-line py-8 first:pt-0 last:border-0 [&_a]:font-medium [&_a]:text-veil-deep [&_a:hover]:underline [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-sunken [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[13px] [&_:not(pre)>code]:text-ink [&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-[16px] [&_h3]:font-semibold [&_h3]:text-ink [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-3 [&_strong]:font-medium [&_strong]:text-ink [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_li]:my-1.5"
    >
      <h2 id={id} className="text-[24px] font-semibold tracking-[-0.02em] text-ink">
        <span id={`${id}-title`}>{title}</span>
      </h2>
      {children}
    </section>
  );
}

function Example({ children }: { children: ReactNode }) {
  return <div className="my-4 rounded-2xl bg-panel p-4 text-[14px] ring-1 ring-line">{children}</div>;
}

function Q({ q, children }: { q: string; children: ReactNode }) {
  return (
    <div className="mt-4">
      <h3 className="!mt-0 !mb-1">{q}</h3>
      <p className="!my-0">{children}</p>
    </div>
  );
}

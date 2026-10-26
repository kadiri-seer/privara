import { useEffect, useState } from "react";
import { api, type Health } from "../api";
import { CodeBlock, CopyButton, ErrorNote, PageHeader, Panel, PanelTitle, Tag } from "../components/ui";

interface Integrations {
  actual: {
    base_url: string;
    rest_base: string;
    openapi: string;
    docs: string;
    mcp_http: string | null;
    mcp_stdio_command: string[];
  };
  tools: { name: string; description: string; action: string }[];
  health: Health;
}

const KEY = "<your-agent-key>";

export function Integrations() {
  const [data, setData] = useState<Integrations | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.get<Integrations>("/api/admin/integrations").then(setData).catch(setError);
  }, []);

  const a = data?.actual;
  const [cmd, ...args] = a?.mcp_stdio_command ?? ["uv"];
  const stdioConfig = JSON.stringify({ mcpServers: { privara: { command: cmd, args, env: { PRIVARA_AGENT_KEY: KEY } } } }, null, 2);
  const httpConfig = JSON.stringify(
    { mcpServers: { privara: { type: "http", url: a?.mcp_http ?? "http://127.0.0.1:8787/mcp", headers: { Authorization: `Bearer ${KEY}` } } } },
    null,
    2,
  );
  const base = a?.rest_base ?? "http://127.0.0.1:8787/api/v1";
  const curlSanitize = `curl -s ${base}/sanitize \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"text": "Send John Okafor the invoice for ₦250,000 at john@example.com.", "session_id": "demo"}'`;
  const curlExecute = `curl -s ${base}/execute \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"tool_name": "read_file", "arguments": {"path": "notes/welcome.txt"}}'`;
  const curlCheck = `curl -s ${base}/check-permission \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"action": "file.write", "resource": "sandbox:outbox/report.txt"}'`;
  const python = `import asyncio, os
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

params = StdioServerParameters(
    command="${cmd}",
    args=${JSON.stringify(args)},
    env={**os.environ, "PRIVARA_AGENT_KEY": os.environ["PRIVARA_AGENT_KEY"]},
)

async def main():
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool("sanitize_text", {"text": "Email ada@example.com"})
            print(result.content[0].text)

asyncio.run(main())`;

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Connect any MCP client or HTTP agent to this gateway. Agents should reach files and tools only through Privara — direct access bypasses every rule here."
      />
      <ErrorNote error={error} />
      <Panel className="mb-6">
        <PanelTitle hint="Read from this running server — these are the real addresses.">
          <span className="inline-flex items-center gap-2">
            This gateway <Tag tone="allow">Live</Tag>
          </span>
        </PanelTitle>
        <dl className="grid gap-x-6 gap-y-3 text-[13px] sm:grid-cols-[180px_1fr]">
          {[
            ["MCP over HTTP", a?.mcp_http ?? "Disabled"],
            ["MCP over stdio", a ? a.mcp_stdio_command.join(" ") : "—"],
            ["REST base URL", a?.rest_base],
            ["OpenAPI schema", a?.openapi],
          ].map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted">{label}</dt>
              <dd className="flex min-w-0 items-center gap-2">
                <code className="min-w-0 truncate font-mono text-[12.5px]">{value ?? "—"}</code>
                {value && value !== "Disabled" ? <CopyButton value={value} /> : null}
              </dd>
            </div>
          ))}
          <dt className="text-muted">API reference</dt>
          <dd>
            {a ? (
              <a href={a.docs} target="_blank" rel="noreferrer" className="text-veil-deep hover:underline">
                Open interactive docs
              </a>
            ) : null}
          </dd>
          <dt className="text-muted">Gateway health</dt>
          <dd>{data ? <Tag tone={data.health.status === "ok" ? "allow" : "deny"}>{data.health.status === "ok" ? "Healthy" : "Degraded"}</Tag> : "—"}</dd>
        </dl>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel>
          <PanelTitle hint="For Claude Desktop, Cursor and other clients that launch MCP servers. Replace the key placeholder.">
            <span className="inline-flex items-center gap-2">
              MCP over stdio <Tag>Example</Tag>
            </span>
          </PanelTitle>
          <CodeBlock label="mcp config (JSON)" code={stdioConfig} />
        </Panel>
        <Panel>
          <PanelTitle hint="For clients that speak streamable HTTP. The key is checked on every call.">
            <span className="inline-flex items-center gap-2">
              MCP over HTTP <Tag>Example</Tag>
            </span>
          </PanelTitle>
          <CodeBlock label="mcp config (JSON)" code={httpConfig} />
        </Panel>
        <Panel>
          <PanelTitle hint="Uses the official MCP Python SDK. Also in examples/mcp_client.py.">
            <span className="inline-flex items-center gap-2">
              Python client <Tag>Example</Tag>
            </span>
          </PanelTitle>
          <CodeBlock label="python" code={python} />
        </Panel>
        <Panel>
          <PanelTitle hint="Sample REST requests. Status codes: 200 executed, 202 needs approval, 403 denied.">
            <span className="inline-flex items-center gap-2">
              REST requests <Tag>Example</Tag>
            </span>
          </PanelTitle>
          <div className="flex flex-col gap-3">
            <CodeBlock label="sanitize" code={curlSanitize} />
            <CodeBlock label="check permission" code={curlCheck} />
            <CodeBlock label="execute a tool" code={curlExecute} />
          </div>
        </Panel>
      </div>

      <Panel className="mt-6">
        <PanelTitle hint="The registry is fixed in code. Agents cannot add tools.">Tools agents can call</PanelTitle>
        <ul className="divide-y divide-line">
          {data?.tools.map((t) => (
            <li key={t.name} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:gap-6">
              <code className="w-36 shrink-0 font-mono text-[13px] font-medium">{t.name}</code>
              <p className="flex-1 text-[13px] text-muted">{t.description}</p>
              <Tag>{t.action}</Tag>
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}

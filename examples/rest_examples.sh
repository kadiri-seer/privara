#!/usr/bin/env bash
# REST walkthrough against a running Privara (./start.sh). Requires curl and python3.
#   PRIVARA_AGENT_KEY=pv_agent_...  PRIVARA_ADMIN_KEY=pv_admin_...  ./examples/rest_examples.sh
set -euo pipefail
BASE="${PRIVARA_URL:-http://127.0.0.1:8787}"
AGENT="Authorization: Bearer ${PRIVARA_AGENT_KEY:?set PRIVARA_AGENT_KEY}"
ADMIN="Authorization: Bearer ${PRIVARA_ADMIN_KEY:?set PRIVARA_ADMIN_KEY}"
JSON="Content-Type: application/json"
field() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }

echo "1. Sanitize"
curl -s "$BASE/api/v1/sanitize" -H "$AGENT" -H "$JSON" \
  -d '{"text":"Send John Okafor the invoice for ₦250,000 at john@example.com.","session_id":"rest-demo"}' | field '["sanitized_text"]'

echo "2. Permission check (decision only, nothing runs)"
curl -s "$BASE/api/v1/check-permission" -H "$AGENT" -H "$JSON" \
  -d '{"action":"file.write","resource":"sandbox:outbox/report.txt"}' | field '["decision"]'

echo "3. Approval-required write → 202"
ARGS='{"path":"outbox/report.txt","content":"Quarterly summary for [PERSON_1]","mode":"overwrite"}'
REQ=$(curl -s "$BASE/api/v1/execute" -H "$AGENT" -H "$JSON" -d "{\"tool_name\":\"write_file\",\"arguments\":$ARGS}" | field '["approval_request_id"]')
echo "   approval request: $REQ"

echo "4. Operator approves"
curl -s -X POST "$BASE/api/admin/approvals/$REQ/approve" -H "$ADMIN" | field '["status"]'

echo "5. Agent collects its one-time token"
TOKEN=$(curl -s "$BASE/api/v1/approvals/$REQ" -H "$AGENT" | field '["approval_token"]')

echo "6. Retry with identical arguments + token → executed"
curl -s "$BASE/api/v1/execute" -H "$AGENT" -H "$JSON" \
  -d "{\"tool_name\":\"write_file\",\"arguments\":$ARGS,\"approval_token\":\"$TOKEN\"}" | field '["status"]'

echo "7. Reusing the token → rejected"
curl -s "$BASE/api/v1/execute" -H "$AGENT" -H "$JSON" \
  -d "{\"tool_name\":\"write_file\",\"arguments\":$ARGS,\"approval_token\":\"$TOKEN\"}" | field '["reason"]'

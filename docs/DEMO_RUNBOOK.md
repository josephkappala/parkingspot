# Parking Spot Memory Demo Runbook

Use this runbook when testing or presenting the Trace glasses skill.

## 1. Start The Server

```bash
npm run build
node dist/index.js
```

Expected output:

```text
Skill template running at http://localhost:3001
```

## 2. Start A Public Tunnel

```bash
ssh -R 80:localhost:3001 nokey@localhost.run
```

Copy the printed HTTPS URL.

## 3. Update Trace Dashboard

Update all skill server URLs:

```text
MCP: https://YOUR-TUNNEL/mcp
Webhook: https://YOUR-TUNNEL/webhook
Deletion webhook: https://YOUR-TUNNEL/delete-user
```

Save the skill after updating.

## 4. Test Text Flow

Fire a new `instant.message` test:

```text
Remember that I parked the car at gate number three.
```

Expected response:

```text
Got it. I will remember where you parked: vehicle: car, gate three.
```

Then fire:

```text
Where did I park the car?
```

Expected response:

```text
You told me: vehicle: car, gate three.
```

## 5. Test Photo Flow

Fire an active image test with an image URL.

Expected response:

```text
Parking photo saved. I see: ... Anything you want me to remember about this spot?
```

Then answer:

```text
This is where I parked.
```

Expected response:

```text
Got it. I added that parking context to the photo memory.
```

## 6. Troubleshooting

If Trace says the skill is unavailable or cannot save:

1. Test the public URL:

   ```bash
   curl -s https://YOUR-TUNNEL/mcp \
     -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
   ```

2. If it returns `no tunnel here`, create a new tunnel and update the dashboard.
3. Do not use old `Re-fire` events after changing URLs.
4. Confirm the local server is still running on port `3001`.

## 7. Persistence Check

Memories are persisted to:

```text
data/parking-memories.json
```

This file is ignored by Git. Restarting the server should not erase saved memories unless you say:

```text
Clear all memories.
```

## 8. Approval Notes

Use this in the review notes field:

```text
Parking Spot Memory helps users save and recall where they parked using Trace glasses voice and active photo events. It supports instant.message and instant.image routing through MCP, returns spoken responses, and logs feed items for saved parking memories.
```

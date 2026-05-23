# Parking Spot Memory

Parking Spot Memory is a Trace glasses skill that helps a user remember where they parked. It supports voice notes and active photo memories, then lets the user ask natural parking questions later.

The skill is built from the Endless River Trace skill template and exposes:

- `POST /mcp` for active voice and active image events.
- `POST /webhook` for signed Trace webhook events.
- `POST /delete-user` for uninstall/data cleanup callbacks.

## What It Does

The skill handles a practical glasses-first workflow:

1. Save a parking location by voice.
2. Save a parking spot by active photo.
3. Add context to a photo memory.
4. Ask where the car is later.
5. Clear saved parking memories for the current server session.
6. Extract structured details such as vehicle, gate, level, floor, row, spot, and landmark.
7. Save GPS coordinates when Trace provides location context.
8. Return Google Maps links for map search and walking directions.

Example phrases:

```text
Remember that I parked the car at gate number three.
Where did I park the car?
Find my parking spot.
Take a photo and remember this location.
Clear all memories.
```

## How It Works

Trace routes active events to the MCP endpoint:

```text
Trace glasses/app -> Trace platform -> POST /mcp -> handle_dialog -> spoken response + feed item
```

Supported triggers in `manifest.json`:

- `instant.message` with `routing_mode: active`
- `instant.image` with `routing_mode: active`

The MCP tool is named `handle_dialog`, which is the preferred Trace entrypoint for conversational skills.

## Local Setup

Requirements:

- Node.js 18+
- npm
- A Trace dashboard skill with an HMAC secret

Install dependencies:

```bash
npm install
```

Create `.env`:

```bash
cp .env.example .env
```

Set the HMAC secret from the Trace dashboard:

```env
TRACE_HMAC_SECRET=your_dashboard_hmac_secret
TRACE_SKILL_ID=your_skill_id_here
BRAIN_BASE_URL=https://brain.endlessriver.ai
PORT=3001
NODE_ENV=development
```

Build and run:

```bash
npm run build
node dist/index.js
```

The local server listens on:

```text
http://localhost:3001
```

## Public URL For Trace

Trace needs a public HTTPS URL. For quick testing, use a tunnel:

```bash
ssh -R 80:localhost:3001 nokey@localhost.run
```

localhost.run will print a URL like:

```text
https://example-subdomain.lhr.life
```

Update the Trace dashboard endpoints:

```text
MCP:
https://example-subdomain.lhr.life/mcp

Webhook:
https://example-subdomain.lhr.life/webhook

Deletion webhook:
https://example-subdomain.lhr.life/delete-user
```

Important: free localhost.run URLs can expire or rotate. If the dashboard returns `no tunnel here`, create a new tunnel and update the dashboard endpoints.

## Dashboard Configuration

Use these values when registering/importing the skill:

- Name: `Parking Spot Memory`
- Interface: `Hybrid`
- Triggers:
  - `instant.message`, active
  - `instant.image`, active
- Permissions:
  - `user.profile.read`
  - `user.location.read`
- Allowed tools: none

Domain description:

```text
Handle voice commands and active photos for remembering where the user parked their car or vehicle. Example phrases: 'remember that I parked at gate number three', 'save this parking spot', 'take a photo and remember this location', 'where did I park the car', 'find my parking spot', and 'clear all parking memories'.
```

## Manual MCP Tests

List available tools:

```bash
curl -s http://localhost:3001/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Save a parking memory:

```bash
curl -s http://localhost:3001/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"handle_dialog","arguments":{"utterance":"Remember that I parked the car at gate number three.","userId":"demo-user"}}}'
```

Recall a parking memory:

```bash
curl -s http://localhost:3001/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"handle_dialog","arguments":{"utterance":"Where did I park the car?","userId":"demo-user"}}}'
```

Save a parking memory with mock GPS location:

```bash
curl -s http://localhost:3001/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"handle_dialog","arguments":{"utterance":"Remember that I parked the car at gate number three.","userId":"demo-user","user":{"id":"demo-user","location":{"latitude":12.9716,"longitude":77.5946,"city":"Bengaluru","country":"IN"}}}}}'
```

Mock an active photo memory:

```bash
curl -s http://localhost:3001/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"handle_dialog","arguments":{"utterance":"","userId":"demo-user","items":[{"id":"item_1","url":"https://example.com/parking.jpg","mimeType":"image/jpeg","imageDescription":"A parking garage entrance with a blue gate number three sign"}],"context":{"source":"instant_image","hasImage":true,"imageDescription":"A parking garage entrance with a blue gate number three sign"}}}}'
```

## Demo Script

Use this order for the most reliable demo:

1. Say: `Clear all memories.`
2. Say: `Remember that I parked the car at gate number three.`
3. Ask: `Where did I park the car?`
4. Trigger active image/photo flow.
5. Say: `This is where I parked.`
6. Ask: `Find my parking spot.`

## Current Limitations

- Memories are stored in `data/parking-memories.json` and survive server restarts.
- The skill uses Trace-provided `imageDescription` for photo memory descriptions.
- GPS capture depends on the user granting `user.location.read` and Trace including location in the MCP payload.
- Free tunnel URLs may expire. Use a deployed HTTPS host for stable demos.
- The current implementation is optimized for a buildathon demo, not long-term production storage.

## Production Improvements

Recommended next steps:

- Deploy to a stable host such as Render, Railway, Fly.io, or a VPS.
- Add a small health endpoint.
- Add unit tests around intent parsing and response shapes.
- Move from JSON file storage to SQLite/Postgres/Supabase for multi-instance production hosting.
- Replace tunnel URLs in `manifest.json` with production URLs before final submission.

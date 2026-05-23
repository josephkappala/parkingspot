import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { verifyTraceSignature } from './hmac';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const TRACE_HMAC_SECRET = process.env.TRACE_HMAC_SECRET || '';
const TRACE_SKILL_ID = process.env.TRACE_SKILL_ID || '';
const BRAIN_BASE_URL = process.env.BRAIN_BASE_URL || 'https://brain.endlessriver.ai';
const DATA_DIR = path.join(process.cwd(), 'data');
const MEMORY_STORE_PATH = path.join(DATA_DIR, 'parking-memories.json');

type ParkingDetails = {
  vehicle?: string;
  gate?: string;
  level?: string;
  floor?: string;
  row?: string;
  spot?: string;
  landmark?: string;
};

type MemoryEntry = {
  id: string;
  type: 'text' | 'photo';
  text: string;
  createdAt: string;
  imageUrl?: string;
  contextNote?: string;
  details?: ParkingDetails;
};

type SkillResponse = {
  spoken: string;
  feedTitle: string;
  feedStory: string;
  embeddedResponses?: any[];
};

const PHOTO_CONTEXT_KEY = 'photo_memory_context';

function loadMemories() {
  try {
    if (!fs.existsSync(MEMORY_STORE_PATH)) return new Map<string, MemoryEntry[]>();
    const parsed = JSON.parse(fs.readFileSync(MEMORY_STORE_PATH, 'utf8')) as Record<string, MemoryEntry[]>;
    return new Map(Object.entries(parsed));
  } catch (err) {
    console.error('[Storage] Could not load parking memories:', err);
    return new Map<string, MemoryEntry[]>();
  }
}

const memoriesByUser = loadMemories();

function persistMemories() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      MEMORY_STORE_PATH,
      JSON.stringify(Object.fromEntries(memoriesByUser), null, 2)
    );
  } catch (err) {
    console.error('[Storage] Could not save parking memories:', err);
  }
}

function saveUserMemories(userId: string, entries: MemoryEntry[]) {
  memoriesByUser.set(userId, entries.slice(-20));
  persistMemories();
}

function getUserId(args: any) {
  return args?.user?.id || args?.userId || 'demo-user';
}

function createMemoryId() {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function cleanMemoryText(utterance: string) {
  return utterance
    .replace(/^(hey trace,?\s*)?/i, '')
    .replace(/^(please\s*)?(remember this location|remember this place|save this location|save this place|remember that|remind me that|note that|log that|save that|remember)[,\s]*/i, '')
    .replace(/\bokay$/i, '')
    .trim()
    .replace(/[.?!]+$/, '');
}

function getImageItem(args: any) {
  return Array.isArray(args?.items) && args.items.length > 0 ? args.items[0] : null;
}

function getImageDescription(args: any) {
  const item = getImageItem(args);
  return (
    item?.imageDescription ||
    args?.context?.imageDescription ||
    'a photo from your Trace glasses'
  );
}

function shortText(text: string, maxLength = 140) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trim()}...`;
}

function extractParkingDetails(text: string): ParkingDetails {
  const normalized = text.toLowerCase();
  const details: ParkingDetails = {};

  if (/\b(bike|motorcycle|scooter)\b/.test(normalized)) details.vehicle = 'bike';
  else if (/\btruck\b/.test(normalized)) details.vehicle = 'truck';
  else if (/\bcar|vehicle\b/.test(normalized)) details.vehicle = 'car';

  const gate = normalized.match(/\bgate\s+(?:number\s+)?([a-z0-9-]+)/i);
  if (gate) details.gate = gate[1];

  const level = normalized.match(/\b(?:level|lvl)\s+([a-z0-9-]+)/i);
  if (level) details.level = level[1];

  const floor = normalized.match(/\b(?:floor|basement)\s+([a-z0-9-]+)/i);
  if (floor) details.floor = floor[1];

  const row = normalized.match(/\brow\s+([a-z0-9-]+)/i);
  if (row) details.row = row[1];

  const spot = normalized.match(/\b(?:spot|slot)\s+(?:number\s+)?([a-z0-9-]+)/i);
  if (spot && !['at', 'in', 'near', 'on'].includes(spot[1])) details.spot = spot[1];

  const landmark = normalized.match(/\bnear\s+(?:the\s+|a\s+|an\s+)?(.+?)(?:\s+at\b|\s+on\b|\.|,|$)/i);
  if (landmark) details.landmark = shortText(landmark[1], 80);

  return details;
}

function mergeParkingDetails(...detailSets: Array<ParkingDetails | undefined>) {
  return Object.assign({}, ...detailSets.filter(Boolean));
}

function formatDetails(details?: ParkingDetails) {
  if (!details || Object.keys(details).length === 0) return '';
  const parts = [
    details.vehicle ? `vehicle: ${details.vehicle}` : null,
    details.gate ? `gate ${details.gate}` : null,
    details.level ? `level ${details.level}` : null,
    details.floor ? `floor ${details.floor}` : null,
    details.row ? `row ${details.row}` : null,
    details.spot ? `spot ${details.spot}` : null,
    details.landmark ? `near ${details.landmark}` : null,
  ].filter(Boolean);

  return parts.join(', ');
}

function formatMemoryForRecall(entry: MemoryEntry) {
  const details = formatDetails(entry.details);
  if (entry.type === 'photo') {
    const context = entry.contextNote ? ` Context: ${entry.contextNote}` : '';
    return `Photo: ${entry.text}.${context}${details ? ` Details: ${details}.` : ''}`;
  }

  return details ? `${entry.text}. Details: ${details}.` : entry.text;
}

function formatParkingMemory(entry: MemoryEntry) {
  const details = formatDetails(entry.details);
  if (details) return details;

  if (entry.type === 'photo') {
    const context = entry.contextNote ? ` ${entry.contextNote}.` : '';
    return `I saved a photo memory: ${entry.text}.${context}`;
  }

  return entry.text;
}

function findMemoryByKeywords(entries: MemoryEntry[], keywords: string[]) {
  return entries
    .slice()
    .reverse()
    .find((entry) => {
      const searchable = `${entry.text} ${entry.contextNote || ''}`.toLowerCase();
      return keywords.some((keyword) => searchable.includes(keyword));
    });
}

function looksLikeParkingLookup(utterance: string) {
  const normalized = utterance.toLowerCase().replace(/[.?!]+$/g, '').trim();
  return (
    normalized.includes('where did i park') ||
    normalized.includes('where is my car') ||
    normalized.includes('where is the car') ||
    /\bwhere\b.*\b(park|parked|parking|car|vehicle)\b/.test(normalized) ||
    /\b(find|locate|take me to)\b.*\b(car|vehicle|parking|spot)\b/.test(normalized) ||
    /\bwhere\b.*\b(my spot|the spot|this location|this place)\b/.test(normalized) ||
    /^(park|parked|parking)\s+(the\s+|my\s+)?(car|vehicle)$/.test(normalized) ||
    /^(repark|repart|report)\s+(the\s+|my\s+)?(car|vehicle)$/.test(normalized) ||
    /^(car|vehicle)\s+(location|parking)$/.test(normalized) ||
    /^(where is|find|locate)\s+(my\s+)?(spot|parking spot)$/.test(normalized)
  );
}

function looksLikeParkingSave(utterance: string) {
  const normalized = utterance.toLowerCase().replace(/[.?!]+$/g, '').trim();
  return (
    /^(remember|save|note|log|remind me)\b/.test(normalized) ||
    /\b(i\s+)?parked\b/.test(normalized) ||
    /\bparking\s+(spot|location|garage|level|floor|gate)\b/.test(normalized) ||
    /\b(car|vehicle)\b.*\b(gate|level|floor|row|spot|garage)\b/.test(normalized) ||
    /\bremember\b.*\b(location|place|spot)\b/.test(normalized)
  );
}

function isExplicitSaveCommand(utterance: string) {
  const normalized = utterance.toLowerCase().replace(/[.?!]+$/g, '').trim();
  return /^(remember|save|note|log|remind me)\b/.test(normalized);
}

function buildPhotoContextResponse(args: any): SkillResponse | null {
  const pendingContext = args?.pending_context;
  if (pendingContext?.context_key !== PHOTO_CONTEXT_KEY) return null;

  const userId = getUserId(args);
  const utterance = String(args?.utterance || '').trim();
  const memoryId = pendingContext?.context_payload?.memory_id;
  const existing = memoriesByUser.get(userId) || [];
  const target = existing.find((entry) => entry.id === memoryId);

  if (!target || target.type !== 'photo') {
    return {
      spoken: 'I could not find that photo memory, but you can capture it again.',
      feedTitle: 'Photo Context Not Added',
      feedStory: utterance || 'No context provided.',
      embeddedResponses: [],
    };
  }

  if (!utterance || /^(skip|no|nope|nothing|no context|that's all)$/i.test(utterance)) {
    return {
      spoken: 'No problem. I saved the photo memory as is.',
      feedTitle: 'Photo Memory Saved',
      feedStory: target.text,
      embeddedResponses: [],
    };
  }

  target.contextNote = cleanMemoryText(utterance) || utterance;
  target.details = mergeParkingDetails(target.details, extractParkingDetails(target.contextNote));
  saveUserMemories(userId, existing);

  return {
    spoken: 'Got it. I added that parking context to the photo memory.',
    feedTitle: 'Parking Context Added',
    feedStory: `${target.text}\nContext: ${target.contextNote}\nDetails: ${formatDetails(target.details) || 'none'}`,
    embeddedResponses: [],
  };
}

function buildPhotoMemoryResponse(args: any): SkillResponse | null {
  const imageItem = getImageItem(args);
  if (!imageItem && !args?.context?.hasImage) return null;

  const userId = getUserId(args);
  const utterance = String(args?.utterance || '').trim();
  const imageDescription = shortText(getImageDescription(args), 170);
  const imageUrl = imageItem?.url;
  const existing = memoriesByUser.get(userId) || [];
  const entry: MemoryEntry = {
    id: createMemoryId(),
    type: 'photo',
    text: imageDescription,
    imageUrl,
    contextNote: utterance ? cleanMemoryText(utterance) || utterance : undefined,
    details: mergeParkingDetails(
      extractParkingDetails(imageDescription),
      utterance ? extractParkingDetails(utterance) : undefined
    ),
    createdAt: new Date().toISOString(),
  };

  saveUserMemories(userId, [...existing, entry]);

  const feedStory = [
    `I see: ${imageDescription}`,
    entry.contextNote ? `User context: ${entry.contextNote}` : null,
    formatDetails(entry.details) ? `Details: ${formatDetails(entry.details)}` : null,
    imageUrl ? `Image: ${imageUrl}` : null,
  ].filter(Boolean).join('\n');

  const responses: any[] = [
    {
      type: 'feed_item',
      content: {
        feed_type: 'skill',
        title: 'Parking Photo Saved',
        story: feedStory,
      },
    },
  ];

  if (!entry.contextNote) {
    responses.push({
      type: 'await_input',
      content: {
        question: 'Anything you want me to remember about this parking spot?',
        context_key: PHOTO_CONTEXT_KEY,
        context_payload: {
          memory_id: entry.id,
          image_description: imageDescription,
          image_url: imageUrl,
        },
        allow_image: false,
        timeout_ms: 300000,
      },
    });
  }

  return {
    spoken: `Parking photo saved. I see: ${imageDescription}.${entry.contextNote ? '' : ' Anything you want me to remember about this spot?'}`,
    feedTitle: 'Parking Photo Saved',
    feedStory,
    embeddedResponses: responses,
  };
}

function buildMemoryResponse(args: any): SkillResponse {
  const photoContextResponse = buildPhotoContextResponse(args);
  if (photoContextResponse) return photoContextResponse;

  const photoMemoryResponse = buildPhotoMemoryResponse(args);
  if (photoMemoryResponse) return photoMemoryResponse;

  const utterance = String(args?.utterance || '').trim();
  const userId = getUserId(args);
  const existing = memoriesByUser.get(userId) || [];
  const normalized = utterance.toLowerCase();

  if (!utterance) {
    return {
      spoken: 'I can remember where you parked. Try saying, remember that I parked near gate 3.',
      feedTitle: 'Parking Assistant Ready',
      feedStory: 'Waiting for a parking memory to save.',
    };
  }

  if (/\b(clear|delete|forget|reset)\b.*\b(all|everything|my notes|memories|our memories|parking memories)\b/.test(normalized)) {
    saveUserMemories(userId, []);
    return {
      spoken: 'Done. I cleared your saved parking memories for this session.',
      feedTitle: 'Parking Memories Cleared',
      feedStory: 'All session parking memories were cleared.',
    };
  }

  if (looksLikeParkingLookup(utterance) || (!isExplicitSaveCommand(utterance) && /\b(park|parking|car|vehicle|spot|gate|garage)\b/.test(normalized))) {
    const parkingMemory = findMemoryByKeywords(existing, ['park', 'parked', 'parking', 'car', 'gate', 'level', 'floor', 'garage', 'spot']);
    if (!parkingMemory) {
      return {
        spoken: 'I do not have a parking memory saved yet.',
        feedTitle: 'No Parking Memory',
        feedStory: 'Try saying “remember that I parked the car at gate number three.”',
      };
    }

    return {
      spoken: `You told me: ${formatParkingMemory(parkingMemory)}.`,
      feedTitle: 'Parking Memory',
      feedStory: formatMemoryForRecall(parkingMemory),
    };
  }

  if (/\b(what|read|list|show|recall)\b.*\b(remember|memories|notes|saved)\b/.test(normalized)) {
    if (existing.length === 0) {
      return {
        spoken: 'You do not have any saved memories yet.',
        feedTitle: 'No Saved Memories',
        feedStory: 'Say “remember that...” to save your first note.',
      };
    }

    const latest = existing.slice(-3).map((entry, index) => `${index + 1}. ${formatMemoryForRecall(entry)}`).join(' ');
    return {
      spoken: `Here are your latest memories. ${latest}`,
      feedTitle: 'Latest Memories',
      feedStory: existing.slice(-5).map((entry) => `- ${formatMemoryForRecall(entry)}`).join('\n'),
    };
  }

  const memoryText = cleanMemoryText(utterance);
  if (memoryText.length < 3) {
    return {
      spoken: 'I did not catch the parking detail. Try saying, remember that I parked the car on level two.',
      feedTitle: 'Parking Memory Not Saved',
      feedStory: utterance,
    };
  }

  const entry: MemoryEntry = {
    id: createMemoryId(),
    type: 'text',
    text: memoryText,
    details: extractParkingDetails(memoryText),
    createdAt: new Date().toISOString()
  };
  saveUserMemories(userId, [...existing, entry]);

  const details = formatDetails(entry.details);
  return {
    spoken: looksLikeParkingSave(utterance)
      ? `Got it. I will remember where you parked: ${details || memoryText}.`
      : `Got it. I will remember: ${memoryText}.`,
    feedTitle: looksLikeParkingSave(utterance) ? 'Parking Memory Saved' : 'Memory Saved',
    feedStory: details ? `${memoryText}\nDetails: ${details}` : memoryText,
  };
}

function buildContent(response: SkillResponse) {
  const content: any[] = [{ type: 'text', text: response.spoken }];
  const embeddedResponses = response.embeddedResponses ?? [
    {
      type: 'feed_item',
      content: {
        feed_type: 'skill',
        title: response.feedTitle,
        story: response.feedStory
      }
    }
  ];

  if (embeddedResponses.length > 0) {
    content.push({
      type: 'embedded_responses',
      responses: embeddedResponses
    });
  }

  return content;
}

// Capture rawBody BEFORE JSON parsing — required for HMAC verification.
app.use(
  express.json({
    verify: (req: any, _res, buf) => { req.rawBody = buf; },
  })
);

// ─── 🟢 Webhook Endpoint ──────────────────────────────────────────────────────
// media.photo, media.audio, media.video events arrive here.
// Always: return 202 immediately, then process asynchronously and POST to callback_url.
app.post('/webhook', verifyTraceSignature(TRACE_HMAC_SECRET), async (req: Request, res: Response) => {
  const { event, user, request_id, callback_url } = req.body;
  console.log(`[Webhook] Received ${event.channel} for user ${user.id}`);

  // Acknowledge immediately — never keep the platform waiting.
  res.status(202).json({ status: 'accepted' });

  // Process asynchronously, then call back with results.
  processEvent({ event, user, requestId: request_id, callbackUrl: callback_url })
    .catch((err) => console.error('[Webhook] processing error:', err));
});

async function processEvent(opts: {
  event: any;
  user: any;
  requestId: string;
  callbackUrl: string;
}) {
  const { event, user, requestId, callbackUrl } = opts;

  // TODO: add your processing logic here (vision, audio, etc.)
  // Then POST the results to callbackUrl.

  const responses = [
    {
      type: 'notification',
      content: {
        title: 'Template Skill',
        body: `Processed your ${event.channel} event.`,
      },
    },
  ];

  await postCallback(callbackUrl, requestId, responses);
}

// ─── 🔵 MCP (JSON-RPC) Endpoint ──────────────────────────────────────────────
// Used for dialog turns (voice queries).
app.post('/mcp', async (req: Request, res: Response) => {
  const { jsonrpc, method, params, id } = req.body;
  console.log('[MCP]', JSON.stringify({
    method,
    tool: params?.name,
    utterance: params?.arguments?.utterance,
    userId: params?.arguments?.userId || params?.arguments?.user?.id,
    hasImage: Boolean(params?.arguments?.items?.length || params?.arguments?.context?.hasImage),
    pendingContext: params?.arguments?.pending_context?.context_key,
  }));

  if (jsonrpc !== '2.0') return res.status(400).send('Invalid JSON-RPC');

  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'handle_dialog',
            description: 'Save and recall where the user parked using voice notes and active photos from Trace glasses.',
            inputSchema: {
              type: 'object',
              properties: {
                utterance: { type: 'string' },
                userId: { type: 'string' },
                user: { type: 'object' },
                items: { type: 'array' },
                context: { type: 'object' },
                pending_context: { type: 'object' }
              }
            }
          }
        ]
      }
    });
  }

  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params || {};
    if (name === 'handle_dialog') {
      try {
        const response = buildMemoryResponse(args);

        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: buildContent(response)
          }
        });
      } catch (err) {
        console.error('[MCP] handler error:', err);
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: 'I hit a small error, but the memory skill is still running. Please try that one more time.'
              }
            ]
          }
        });
      }
    }
  }

  res.status(404).json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
});

// ─── Callback helper ─────────────────────────────────────────────────────────
// Sign and POST the skill's response back to the platform after async processing.

async function postCallback(callbackUrl: string, requestId: string, responses: any[]) {
  const body      = JSON.stringify({ request_id: requestId, status: 'success', responses });
  const timestamp = Date.now().toString();
  const signature = 'sha256=' + crypto
    .createHmac('sha256', TRACE_HMAC_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  const res = await fetch(callbackUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Trace-Timestamp': timestamp,
      'X-Trace-Signature': signature,
    },
    body,
  });
  console.log(`[Callback] → ${res.status}`);
}

// ─── 🟣 Proactive Push API Helper ───────────────────────────────────────────
// Use this to send responses on your own schedule (cron, job queue, etc.)
// without a triggering event from the platform.

async function sendPushResponse(user_id: string, responses: any[]) {
  const url = `${BRAIN_BASE_URL}/api/skill-push/${TRACE_SKILL_ID}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TRACE_HMAC_SECRET}`,
    },
    body: JSON.stringify({ user_id, responses }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[Push] ${res.status} ${text}`);
  }
}

// ─── Lifecycle / Deletion ────────────────────────────────────────────────────
app.post('/delete-user', (req: Request, res: Response) => {
  const { user_id } = req.body;
  console.log(`[Cleanup] Deleting data for user ${user_id}`);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`🚀 Skill template running at http://localhost:${PORT}`);
});

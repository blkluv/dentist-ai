// index.js — Dentist AI Receptionist (Twilio + Render + OpenAI Realtime)

import express from "express";
import bodyParser from "body-parser";
import http from "http";
import { WebSocketServer } from "ws";
import fetch from "node-fetch";

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;          // +1XXXXXXXXXX
const FRONT_DESK_NUMBER = process.env.FRONT_DESK_NUMBER;  // +1YYYYYYYYYY
const RENDER_HOST = process.env.RENDER_HOST || "dentist-ai.onrender.com"; // set to your Render host (no protocol)

// ---------- EXPRESS ----------
const app = express();
// Twilio posts urlencoded webhook bodies by default
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Simple health check
app.get("/", (_req, res) => res.status(200).send("Dentist AI is alive"));

// ---------- In-house "KB" & demo slots ----------
const FAQ = {
  hours: "Mon–Fri 8am–5pm; Sat 9am–1pm; closed Sunday.",
  address: "1234 Naples Blvd, Suite 200, Naples, FL 34102.",
  insurance: "We accept most PPO plans including Delta Dental and Cigna. Call for specifics.",
  parking: "Free lot behind the building; enter via 2nd Street.",
  new_patients: "Yes, we’re accepting new patients. Bring a photo ID and your insurance card."
};

const SLOTS = [
  { id: "tue-1030", label: "Tue 10:30 AM (Hygienist)" },
  { id: "tue-1415", label: "Tue 2:15 PM (Hygienist)" },
  { id: "wed-0900", label: "Wed 9:00 AM (Dr. Lee)" }
];

// ---------- Twilio SMS helper (used by sendSMS tool) ----------
async function sendSMS(to, body) {
  const twilio = (await import("twilio")).default;
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const msg = await client.messages.create({ to, from: TWILIO_NUMBER, body });
  return msg.sid;
}

// ---------- Tool router ----------
async function handleToolCall(name, args) {
  if (name === "getFAQ") {
    const q = (args.question || "").toLowerCase();
    let a = "";
    if (q.includes("hour")) a = FAQ.hours;
    else if (q.includes("address") || q.includes("location")) a = FAQ.address;
    else if (q.includes("insurance")) a = FAQ.insurance;
    else if (q.includes("parking")) a = FAQ.parking;
    else if (q.includes("new patient")) a = FAQ.new_patients;
    else a = "I'm not sure—let me connect you to our staff.";
    return { answer: a };
  }
  if (name === "getSlots") return { slots: SLOTS };
  if (name === "bookSlot") {
    const found = SLOTS.find(s => s.id === args.slotId);
    if (!found) return { ok: false, error: "Slot not found" };
    // TODO: replace with Google Calendar create-event
    if (args.phone) await sendSMS(args.phone, `Booked: ${found.label}. Address: ${FAQ.address}`);
    return { ok: true, booked: found };
  }
  if (name === "sendSMS") {
    const sid = await sendSMS(args.to, args.message);
    return { ok: true, sid };
  }
  return { ok: false, error: "Unknown tool" };
}

// ---------- System prompt (safety) ----------
const SYSTEM_PROMPT = `
You are "Smile Dental's AI Receptionist".
SCOPE: logistics only (hours, address, insurance, parking, basic services) + booking/rescheduling.
NEVER provide medical advice, diagnoses, medication or treatment recommendations.
For clinical questions, say: "I'm not allowed to give medical advice. Let me connect you to our staff."
Confirm details before booking (name spelling, phone, date/time). Offer 1–2 slot options, then confirm.
If unclear after one follow-up, escalate to staff.
If caller says "operator" or presses 0, connect to the front desk.
Keep replies concise and polite.
`;

// ---------- Twilio Voice webhook: returns TwiML to open Media Stream ----------
app.post("/voice", (req, res) => {
  // Defensive: if the brain is not configured, route to human immediately
  if (!OPENAI_API_KEY) {
    console.error("Missing OPENAI_API_KEY — dialing front desk fallback.");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Connecting you to our front desk.</Say><Dial>${FRONT_DESK_NUMBER}</Dial></Response>`;
    return res.type("text/xml").send(twiml);
  }

  // Use a stable host (avoid surprises from proxies)
  const host = RENDER_HOST || req.headers["x-forwarded-host"] || req.headers.host;
  console.log("VOICE webhook hit. host =", host);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Thanks for calling Smile Dental. One moment while I connect you.</Say>
  <Connect>
    <Stream
      url="wss://${host}/twilio-media"
      name="receptionist"
      statusCallback="https://${host}/stream-status"
      statusCallbackMethod="POST"
      statusCallbackEvent="start completed failed"/>
  </Connect>
</Response>`;
  res.type("text/xml").send(twiml);
});

// Optional: allow external digits routing later if you want
app.post("/dtmf", (_req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial>${FRONT_DESK_NUMBER}</Dial></Response>`;
  res.type("text/xml").send(twiml);
});

// Twilio stream status callback (diagnostics)
app.post("/stream-status", (req, res) => {
  console.log("STREAM STATUS:", req.body);
  res.sendStatus(200);
});

// ---------- HTTP + WS server ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  console.log("HTTP upgrade requested:", req.url);
  if (req.url === "/twilio-media") {
    wss.handleUpgrade(req, socket, head, (ws) => handleTwilioMedia(ws));
  } else {
    socket.destroy();
  }
});
server.listen(PORT, () => console.log("HTTP+WS server on", PORT));

// ---------- OpenAI Realtime session helper ----------
async function startRealtimeSession() {
  const payload = {
    model: "gpt-4o-realtime-preview",     // use a realtime-capable model available to your account
    voice: "alloy",
    input_audio_format: "g711_ulaw",
    output_audio_format: "g711_ulaw",
    turn_detection: { type: "server_vad", threshold: 0.7 },
    instructions: SYSTEM_PROMPT,
    tools: [
      {
        type: "function",
        name: "getFAQ",
        description: "Answer basic FAQ",
        parameters: {
          type: "object",
          properties: { question: { type: "string" } },
          required: ["question"]
        }
      },
      {
        type: "function",
        name: "getSlots",
        description: "List appointment slots",
        parameters: {
          type: "object",
          properties: {
            date: { type: "string" },
            provider: { type: "string" },
            window: { type: "string" }
          }
        }
      },
      {
        type: "function",
        name: "bookSlot",
        description: "Book a slot",
        parameters: {
          type: "object",
          properties: {
            slotId: { type: "string" },
            name:   { type: "string" },
            phone:  { type: "string" },
            reason: { type: "string" }
          },
          required: ["slotId", "name", "phone"]
        }
      },
      {
        type: "function",
        name: "sendSMS",
        description: "Send an SMS via Twilio",
        parameters: {
          type: "object",
          properties: {
            to: { type: "string" },
            message: { type: "string" }
          },
          required: ["to", "message"]
        }
      }
    ]
  };

  const r = await fetch("https://api.openai.com/v1/realtime/sessions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(text);
  }
  return r.json(); // contains client_secret.value for the WS connect header
}

// ---------- Twilio Media Streams <-> OpenAI Realtime bridge ----------
async function handleTwilioMedia(ws) {
  console.log("Twilio media stream CONNECTED");
  ws.on("error", (e) => console.error("Twilio media stream ERROR:", e));
  ws.on("close", (code, reason) => console.log("Twilio media stream CLOSED:", code, reason?.toString()));

  // If key missing, bail early (defensive)
  if (!OPENAI_API_KEY) {
    try { ws.close(); } catch {}
    return;
  }

  // Start OpenAI realtime session
  let rt;
  try {
    const session = await startRealtimeSession();
    const { WebSocket } = await import("ws");
    rt = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": `realtime-session=${session.client_secret.value}`
        }
      }
    );

    // When model socket opens, proactively greet the caller
    rt.on("open", () => {
      console.log("OpenAI Realtime connected");
      rt.send(JSON.stringify({
        type: "response.create",
        response: {
          instructions:
            "Greet the caller as Smile Dental's receptionist and ask how you can help (hours, address, insurance, booking). Keep it concise.",
          modalities: ["audio"]
        }
      }));
    });

    rt.on("error", (e) => console.error("Realtime error", e));
    rt.on("close", () => {
      try { ws.close(); } catch {}
    });

    // Model -> Twilio (audio) and tool calls
    rt.on("message", async (buf) => {
      try {
        const evt = JSON.parse(buf.toString());
        if (evt.type === "audio.delta") {
          // send audio back to caller
          ws.send(JSON.stringify({ event: "media", media: { payload: evt.audio } }));
        } else if (evt.type === "response.function_call") {
          const { name, arguments: args, call_id } = evt;
          const result = await handleToolCall(name, args || {});
          rt.send(JSON.stringify({
            type: "response.function_call_output",
            call_id,
            output: JSON.stringify(result)
          }));
        }
      } catch (e) {
        console.error("Model message handler error:", e);
      }
    });

  } catch (e) {
    console.error("Failed to start Realtime:", e.message || e);
    try { ws.close(); } catch {}
    return;
  }

  // Twilio -> Model (caller audio frames)
  ws.on("message", (buf) => {
    try {
      const msg = JSON.parse(buf.toString());
      if (msg.event === "start") {
        console.log("Twilio START:", msg.start?.callSid);
      } else if (msg.event === "media") {
        // Append caller audio to model’s input buffer
        if (rt && rt.readyState === 1) {
          rt.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
        }
      } else if (msg.event === "stop") {
        console.log("Twilio STOP");
        if (rt && rt.readyState === 1) {
          rt.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          rt.send(JSON.stringify({ type: "response.create" })); // ask model to respond
        }
      }
    } catch {}
  });
}

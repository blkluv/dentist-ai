// ----- imports & setup -----
import express from "express";
import bodyParser from "body-parser";
import http from "http";
import { WebSocketServer } from "ws";
import fetch from "node-fetch";

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;
const FRONT_DESK_NUMBER = process.env.FRONT_DESK_NUMBER;

// ----- dentist FAQ (in-house KB for instant answers) -----
const FAQ = {
  hours: "Mon–Fri 8am–5pm; Sat 9am–1pm; closed Sunday.",
  address: "1234 Naples Blvd, Suite 200, Naples, FL 34102.",
  insurance: "We accept most PPO plans including Delta Dental and Cigna. Call for specifics.",
  parking: "Free lot behind the building; enter via 2nd Street.",
  new_patients: "Yes, we are accepting new patients. Please bring a photo ID and insurance card."
};

// ----- demo appointment slots (replace with Google Calendar later) -----
const SLOTS = [
  { id: "tue-1030", label: "Tue 10:30 AM (Hygienist)" },
  { id: "tue-1415", label: "Tue 2:15 PM (Hygienist)" },
  { id: "wed-0900", label: "Wed 9:00 AM (Dr. Lee)" }
];

// ----- helper: SMS via Twilio -----
async function sendSMS(to, body) {
  const twilio = (await import("twilio")).default;
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const msg = await client.messages.create({ to, from: TWILIO_NUMBER, body });
  return msg.sid;
}

// ----- tools the model is allowed to call -----
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

// ----- strict safety & behavior rules -----
const SYSTEM_PROMPT = `
You are "Smile Dental's AI Receptionist".
SCOPE: logistics only (hours, address, insurance, parking, basic services) + booking/rescheduling.
NEVER provide medical advice, diagnoses, medication or treatment recommendations.
For clinical questions, say: "I'm not allowed to give medical advice. Let me connect you to our staff."
Always confirm details before booking (name spelling, phone number, date/time).
Offer 1–2 slot options, then confirm. If unclear after one follow-up, escalate to staff.
If caller says "operator" or presses 0, connect to the front desk.
Keep replies concise and polite.
`;

// ----- Express: Twilio webhook returns TwiML to open a Media Stream -----
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

app.post("/voice", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" timeout="0" numDigits="1" action="/dtmf">
    <Say>Thanks for calling Smile Dental. One moment while I connect you.</Say>
    <Connect>
      <Stream url="wss://${host}/twilio-media" track="both_audio" name="receptionist"/>
    </Connect>
  </Gather>
</Response>`;
  res.type("text/xml").send(twiml);
});

// If the caller presses a key, forward to human (0 is common)
app.post("/dtmf", (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial>${FRONT_DESK_NUMBER}</Dial></Response>`;
  res.type("text/xml").send(twiml);
});

// ----- WS bridge: Twilio Media Streams <-> OpenAI Realtime -----
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/twilio-media") wss.handleUpgrade(req, socket, head, (ws) => handleTwilioMedia(ws));
  else socket.destroy();
});
server.listen(PORT, () => console.log("HTTP+WS server on", PORT));

async function startRealtimeSession() {
  // Start a short-lived session; use the realtime model name enabled in your account
  const r = await fetch("https://api.openai.com/v1/realtime/sessions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-realtime-preview",  // if this 404s, check your OpenAI dashboard for the exact realtime model name
      voice: "alloy",
      input_audio_format: "g711_ulaw",   // match Twilio
      output_audio_format: "g711_ulaw",
      turn_detection: { type: "server_vad", threshold: 0.7 },
      instructions: SYSTEM_PROMPT,
      tools: [
        { name: "getFAQ",   description: "Answer basic FAQ", parameters: { type: "object", properties: { question: { type: "string" }}, required: ["question"] } },
        { name: "getSlots", description: "List appointment slots", parameters: { type: "object", properties: { date: { type: "string" }, provider: { type: "string" }, window: { type: "string" } } } },
        { name: "bookSlot", description: "Book a slot", parameters: { type: "object", properties: { slotId: { type: "string" }, name: { type: "string" }, phone: { type: "string" }, reason: { type: "string" } }, required: ["slotId","name","phone"] } },
        { name: "sendSMS",  description: "Send an SMS", parameters: { type: "object", properties: { to: { type: "string" }, message: { type: "string" } }, required: ["to","message"] } }
      ]
    })
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json(); // contains client_secret.value
}

async function handleTwilioMedia(ws) {
  try {
    const session = await startRealtimeSession();
    const rt = new (await import("ws")).WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": `realtime-session=${session.client_secret.value}` } }
    );

    // Wiring: caller → OpenAI
    ws.on("message", (buf) => {
      try {
        const msg = JSON.parse(buf.toString());
        if (msg.event === "media") {
          rt.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
        } else if (msg.event === "stop") {
          rt.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          rt.send(JSON.stringify({ type: "response.create" }));
        }
      } catch {}
    });

    // Wiring: OpenAI → caller (audio) + tools
    rt.on("message", async (buf) => {
      try {
        const evt = JSON.parse(buf.toString());
        if (evt.type === "audio.delta") {
          ws.send(JSON.stringify({ event: "media", media: { payload: evt.audio }}));
        } else if (evt.type === "response.function_call") {
          const { name, arguments: args, call_id } = evt;
          const result = await handleToolCall(name, args || {});
          rt.send(JSON.stringify({ type: "response.function_call_output", call_id, output: JSON.stringify(result) }));
        }
      } catch (e) { console.error("handler error", e); }
    });

    rt.on("open", () => console.log("OpenAI Realtime connected"));
    rt.on("close", () => ws.close());
    rt.on("error", (e) => console.error("Realtime error", e));
    ws.on("close", () => rt.close());
  } catch (e) {
    console.error("Failed to start Realtime:", e.message);
    // Optional: redirect call to human on error
  }
}

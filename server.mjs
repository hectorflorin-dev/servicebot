import express from "express";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";
import axios from "axios";
import twilio from "twilio";
import dotenv from "dotenv";
dotenv.config();

// ============================================
//  OPENAI CLIENT
// ============================================
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ============================================
//  EXPRESS SETUP
// ============================================
const app = express();
const port = process.env.PORT || 3000;


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ============================================
//  SYSTEM PROMPTS
// ============================================
const systemPrompt_OLD = `
You are a sarcastic OrderBot, an automated service to collect orders for a pizza restaurant.
You first greet the customer, then collect the order,
and then ask if it's a pickup or delivery.
If the customer changes the language you'll continue the conversation on that language.
You wait to collect the entire order, then summarize it and check for a final
time if the customer wants to add anything else.
If it's a delivery, you ask for an address.
Finally you collect the payment.
Make sure to clarify all options, extras and sizes to uniquely
identify the item from the menu.
You respond in a short, very conversational friendly style.

When the order is fully confirmed (items, pickup/delivery, and payment),
END your final message with this exact tag: [[ORDER_COMPLETED]].
Do not use this tag at any other time.

The menu includes:
pepperoni pizza 12.95, 10.00, 7.00
cheese pizza 10.95, 9.25, 6.50
eggplant pizza 11.95, 9.75, 6.75
fries 4.50, 3.50
greek salad 7.25
Choripan 5.00

Toppings:
extra cheese 2.00
mushrooms 1.50
sausage 3.00
canadian bacon 3.50
AI sauce 1.50
peppers 1.00

Drinks:
coke 3.00, 2.00, 1.00
sprite 3.00, 2.00, 1.00
bottled water 5.00
mote con huesillo 3.00, 4.00, 6.00
`;

const systemPrompt = `
You are KunAI, an IT support assistant.

GOAL:
- Help users with IT issues, requests, and feedback.
- Collect all info needed to open an IT support ticket.

STYLE:
- Reply in the user's language.
- Short, friendly, slightly sarcastic (never rude).

FLOW:
1) Greet the user. Ask what issue or request they have.
2) Ask for the details you need:
   - What is happening?
   - Where? (system/app/device/location/company)
   - Since when / how often?
   - Errors, screenshots, steps to reproduce (if relevant)
3) Collect contact info:
   - Name
   - Location/company
   - Optional phone
4) Summarize everything, confirm with the user, and ask if they want to add anything.

WHEN READY TO CREATE A TICKET:
1) Tell the user you are submitting their request.
2) Then output a machine-readable block (tags in English only):

<ticket>
<su>{short summary in user's language}</su>
<de>{full description in user's language}</de>
<ca>{category in English: Hardware, Software, Access, Network, Feedback, etc.}</ca>
</ticket>

3) After </ticket>, end with: [[ORDER_COMPLETED]]
Use [[ORDER_COMPLETED]] ONLY when a ticket is ready.

If the user only needs general help, answer normally without a ticket.
`;

const sentimentSystemPrompt = `
You are a toxicity classifier.
Classify the user's message into one of these categories:

- "safe" (polite, neutral, friendly, or harmless)
- "rude" (angry, disrespectful, unfriendly, using strong negative tone)
- "offensive" (insults, harassment, hate, slurs, threats, explicit abuse)

Respond with exactly one of these words.
No explanations. No additional text.
`;

// ============================================
//  JIRA CLOUD CONFIG
// ============================================

// Better to move these into environment variables in real use
const JIRA_BASE_URL = process.env.JIRA_BASE_URL; // <-- your Jira Cloud URL
const JIRA_EMAIL = process.env.JIRA_EMAIL; // <-- Atlassian account email
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY; // <-- project key for orders
const JIRA_ISSUE_TYPE = process.env.JIRA_ISSUE_TYPE; // or "Story" / "Order" etc.

const jiraAuthHeader = {
  Authorization:
    "Basic " + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64"),
};

/**
 * Creates a Jira issue for a completed order.
 * @param {string} summary - Short title for the issue.
 * @param {string} description - Full order text (from the bot).
 */
async function createJiraIssue(summary, description) {
  const url = `${JIRA_BASE_URL}/rest/api/3/issue`;

  // Convert plain text description into Atlassian Document Format (ADF)
  const descriptionADF = {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: description,
          },
        ],
      },
    ],
  };

  const payload = {
    fields: {
      project: { key: JIRA_PROJECT_KEY },
      summary,
      issuetype: { name: JIRA_ISSUE_TYPE },
      description: descriptionADF, // 👈 ADF instead of plain string
    },
  };

  const headers = {
    ...jiraAuthHeader,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const res = await axios.post(url, payload, { headers });
  return res.data; // includes issue key, id, etc.
}

// ============================================
//  EMAIL SENDER (Nodemailer)
// ============================================
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER, // <-- your Gmail address
    pass: process.env.GMAIL_TOKEN, // <-- Gmail App Password
  },
});

async function sendOrderEmail(orderText) {
  return transporter.sendMail({
    from: '"KunAI Service Bot" <jira.dc.testing2@gmail.com>',
    to: "kunstock@yahoo.com", // <-- Where orders should be emailed
    subject: "Nuevo Requerimiento  🛠️",
    text: orderText,
  });
}

// ============================================
//  RATE LIMIT RETRY WRAPPER + TOKEN LOGGING
// ============================================
async function callOpenAIWithRetry(payload, retries = 3, usageLabel = "") {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await client.responses.create(payload);

      // 🔢 Log de uso de tokens
      const usage = response.usage || {};
      const inputTokens = usage.input_tokens ?? usage.prompt_tokens;
      const outputTokens = usage.output_tokens ?? usage.completion_tokens;
      const totalTokens = usage.total_tokens;

      console.log(
        `🔢 OpenAI usage${usageLabel ? " (" + usageLabel + ")" : ""} ${payload.model}`
      );
      console.log(
        "   input_tokens:",
        inputTokens,
        "output_tokens:",
        outputTokens,
        "total_tokens:",
        totalTokens
      );

      return response;
    } catch (err) {
      if (err.status === 429 && i < retries - 1) {
        const delayMs = (i + 1) * 1000;
        console.warn(`⚠️ Rate limited, retrying in ${delayMs}ms.`);
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        throw err;
      }
    }
  }
}

// ============================================
//  SENTIMENT ANALYZER (currently unused)
// ============================================
async function getSentimentForMessage(message) {
  const response = await callOpenAIWithRetry(
    {
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: sentimentSystemPrompt },
        { role: "user", content: message },
      ],
    },
    3,
    "sentiment"
  );

  const raw = response.output_text?.trim().toLowerCase() || "safe";

  if (raw.includes("rude")) return "rude";
  if (raw.includes("offensive")) return "offensive";
  if (raw.includes("safe")) return "safe";
  return "safe";
}

// ============================================
//  EXTRACT TICKET INFO
// ============================================
function extractTicketFields(text) {
  const get = (tag) => {
    const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
    const match = text.match(regex);
    return match ? match[1].trim() : null;
  };

  return {
    summary: get("su"),
    description: get("de"),
    category: get("ca"),
  };
}

// ============================================
//  ORDER COMPLETION DETECTOR
// ============================================
function isOrderCompleted(reply) {
  return reply.toLowerCase().includes("[[order_completed]]");
}

// Strip the tag before showing to user
function stripOrderCompletedTag(reply) {
  return reply.replace(/\s*\[\[ORDER_COMPLETED\]\]\s*/gi, "").trim();
}

function stripTicketBlock(reply) {
  // Remove the entire <ticket>.</ticket> block if present
  return reply.replace(/<ticket>[\s\S]*?<\/ticket>/i, "").trim();
}

// ============================================
//  IN-MEMORY SESSIONS
// ============================================
const sessions = new Map();

// how many non-system messages before we start summarizing
const MAX_HISTORY_MESSAGES_BEFORE_SUMMARY = 20;
// how long the summary should be
const SUMMARY_MAX_OUTPUT_TOKENS = 200;

/**
 * Get or create context for a given session.
 */
function getContextForSession(sessionId) {
  if (!sessions.has(sessionId)) {
    console.log(`🆕 New session created: ${sessionId}`);
    sessions.set(sessionId, [{ role: "system", content: systemPrompt }]);
  }
  return sessions.get(sessionId);
}

/**
 * Summarize long conversations to keep "knowledge" but reduce token usage.
 * Replaces all non-system messages with a single summary message.
 */
async function summarizeContextIfNeeded(sessionId) {
  const context = sessions.get(sessionId);
  if (!context) return;

  // context[0] is system; count the rest
  const nonSystemMessages = context.slice(1);
  if (nonSystemMessages.length <= MAX_HISTORY_MESSAGES_BEFORE_SUMMARY) {
    return;
  }

  console.log(
    `📝 Summarizing context for session ${sessionId}. Messages: ${nonSystemMessages.length}`
  );

  const summarySystemPrompt = `
You are a helpful assistant that summarizes chat history for another model.
Given the conversation between a user and an IT support bot, produce a concise summary
(200 words or fewer) of everything that has happened so far, including:
- The user's requirements, issues and context
- Any important preferences (language, contact details, device, location, etc.)
- Key decisions and resolutions reached so far

The summary should be in plain text and can be in the same language(s) as the conversation.
Do NOT add new information. Just summarize what is there.
`;

  const summaryResponse = await callOpenAIWithRetry(
    {
      model: "gpt-4o-mini", // "gpt-4.1-mini",
      input: [
        { role: "system", content: summarySystemPrompt },
        ...nonSystemMessages,
      ],
      max_output_tokens: SUMMARY_MAX_OUTPUT_TOKENS,
      temperature: 0.2,
    },
    3,
    `summary for session ${sessionId}`
  );

  const summaryText =
    summaryResponse.output_text ||
    "Summary of the previous conversation so far (details omitted).";

  const newContext = [
    context[0], // system
    {
      role: "assistant",
      content: `Conversation summary so far:\n${summaryText}`,
    },
  ];

  sessions.set(sessionId, newContext);

  console.log(
    `✅ Context summarized for session ${sessionId}. New length: ${newContext.length}`
  );
}

// ============================================
//  MAIN CHAT HANDLER
// ============================================
async function handleChatMessage(message, sessionId) {
  const sid = sessionId || "default-session";
  // ensure context exists
  getContextForSession(sid);

  // 0. Summarize context if it's already too long (before adding new user msg)
  await summarizeContextIfNeeded(sid);

  const context = getContextForSession(sid);

  console.log("Incoming message (channel-agnostic):", { message, sid });

  // 1. Sentiment check (DISABLED for now)
  /*
  console.log("Checking sentiment...");
  const sentiment = await getSentimentForMessage(message);
  console.log("Sentiment:", sentiment);

  if (sentiment !== "safe") {
    const safeReply =
      "Hey, solo soy el perkin aca. Let’s keep it friendly – ¿en qué te puedo ayudar?";
    context.push({ role: "user", content: message });
    context.push({ role: "assistant", content: safeReply });
    return {
      reply: safeReply,
      orderCompleted: false,
      jiraIssueKey: null,
    };
  }
  */

  // 2. Normal conversation flow
  context.push({ role: "user", content: message });

  console.log("Calling OrderBot model...");
  const response = await callOpenAIWithRetry(
    {
      model: "gpt-4o-mini", // "gpt-4.1-mini",
      input: context,
      max_output_tokens: 400, // cap reply length to save tokens
      temperature: 0.3,
    },
    3,
    `chat for session ${sid}`
  );

  let assistantText =
    response.output_text || "Sorry, I had trouble answering that.";

  console.log("Assistant reply (raw):", assistantText);

  // 3. Detect completion and extract machine-readable fields
  const completed = isOrderCompleted(assistantText);

  const {
    summary: ticketSummary,
    description: ticketDescription,
    category: ticketCategory,
  } = extractTicketFields(assistantText);

  // 4. Strip tags the user SHOULD NOT see
  let cleanedReply = stripOrderCompletedTag(assistantText); // MUST be let, not const
  cleanedReply = stripTicketBlock(cleanedReply); // remove <ticket>...</ticket>

  console.log("Order completed?", completed);

  let jiraIssueKey = null;

  // Save the user-visible reply
  context.push({ role: "assistant", content: cleanedReply });

  // 5. If completed, send email + create Jira ticket
  if (completed) {
    console.log("📧 Order completed. Sending email & creating Jira issue...");

    // email
    try {
      await sendOrderEmail(cleanedReply);
      console.log("📬 Email sent!");
    } catch (err) {
      console.error("❌ Email failed:", err);
    }

    // jira
    try {
      const summary = ticketSummary || "New support request 🛠️ from KunAI";
      const description =
        ticketDescription ||
        `${cleanedReply}\n\n(Category: ${ticketCategory || "Uncategorized"})`;

      const jiraIssue = await createJiraIssue(summary, description);
      jiraIssueKey = jiraIssue.key;
      console.log("✅ Jira issue created:", jiraIssueKey);

      // OPTIONAL: after a completed ticket, reset context to start fresh next time
      sessions.set(sid, [{ role: "system", content: systemPrompt }]);
    } catch (jiraErr) {
      console.error(
        "❌ Failed to create Jira issue:",
        jiraErr.response?.data || jiraErr
      );
    }
  }

  // 6. Return values for Web/WhatsApp UI
  return {
    reply: cleanedReply,
    orderCompleted: completed,
    jiraIssueKey,
  };
}

// ============================================
//  MAIN CHAT ENDPOINT
// ============================================
app.post("/api/chat", async (req, res) => {
  try {
    const { message, sessionId } = req.body || {};

    console.log("Incoming /api/chat:", { message, sessionId });

    if (!message) {
      return res.status(400).json({ error: "Missing 'message' in body" });
    }

    const result = await handleChatMessage(message, sessionId);

    // result = { reply, orderCompleted, jiraIssueKey }
    res.json(result);
  } catch (err) {
    console.error("Error in /api/chat:", err);

    if (err.status === 429 || err.code === "rate_limit_exceeded") {
      return res.status(429).json({
        error: "rate_limited",
        message: "I’m getting a bit overwhelmed 😅. Try again shortly!",
      });
    }

    res.status(500).json({ error: "Server error", details: "Unexpected error" });
  }
});

// ============================================
//  Twilio WhatsApp webhook
// ============================================
app.post(
  "/whatsapp/webhook",
  express.urlencoded({ extended: false }), // Twilio sends form-encoded data
  async (req, res) => {
    try {
      const from = req.body.From; // e.g. "whatsapp:+56941208411"
      const body = req.body.Body || ""; // user message text

      console.log("Incoming WhatsApp message:", { from, body });

      const sessionId = from; // phone = session ID for that user

      const result = await handleChatMessage(body, sessionId);
      // result = { reply, orderCompleted, jiraIssueKey }

      let finalReply = result.reply;

      // If the order was completed AND we have a Jira key, append it for WhatsApp
      if (result.orderCompleted && result.jiraIssueKey) {
        finalReply += `\n\n✅ Tu ticket ha sido creado.\nNúmero de ticket: *${result.jiraIssueKey}*`;
        // You can phrase this however you like, in Spanish/English/etc.
      }

      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(finalReply);

      res.type("text/xml").send(twiml.toString());
    } catch (err) {
      console.error("Error in /whatsapp/webhook:", err);
      res.status(500).send("Server error");
    }
  }
);

// ============================================
//  RESET SESSION
// ============================================
app.post("/api/reset", (req, res) => {
  const { sessionId } = req.body || {};
  console.log("Reset request for session:", sessionId);
  if (sessionId && sessions.has(sessionId)) {
    sessions.delete(sessionId);
  }
  return res.json({ ok: true });
});

// ============================================
//  SERVE FRONTEND
// ============================================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ============================================
//  START SERVER
// ============================================
app.listen(port, () => {
  console.log(`🛠️ KunAI web server running at http://localhost:${port}`);
});

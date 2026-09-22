const express = require("express");
const cors = require("cors");
require("dotenv").config();

const OpenAI = require("openai");

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com"
});

const openrouter = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1"
});

app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    message: "Programming AI server is running"
  });
});

app.post("/api/ask-ai", async (req, res) => {
  try {
    const { code, error, provider } =
     req.body;
     console.log("PROVIDER:", provider);
    if (!code) {
      return res.status(400).json({
        success: false,
        message: "Code is required"
      });
    }

    const prompt = `
You are a concise programming debugging assistant.

Analyze the code and error.

CODE:
${code}

ERROR:
${error || "No error provided"}

Reply ONLY in this format:

1. What is wrong:
2. Why it happened:
3. Corrected code:
4. Short explanation:

Keep the answer short. Make sure the corrected code is valid.
`;

    if (provider === "openrouter") {
      const response = await openrouter.chat.completions.create({
        model: "cohere/north-mini-code:free",
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.2,
        max_tokens: 1024
      });

      const answer =
        response.choices?.[0]?.message?.content ||
        response.choices?.[0]?.message?.reasoning ||
        "";

      return res.json({
        success: true,
        provider: "OpenRouter Free",
        answer
      });
    }

    if (provider === "local") {
      const localResponse = await fetch(
        "http://127.0.0.1:8080/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            messages: [
              {
                role: "user",
                content: prompt
              }
            ],
            temperature: 0.2,
            max_tokens: 512
          })
        }
      );

      const data = await localResponse.json();

      if (!localResponse.ok) {
        throw new Error(
          data.error?.message ||
          `Local AI HTTP ${localResponse.status}`
        );
      }

      const answer =
        data.choices?.[0]?.message?.content || "";

      return res.json({
        success: true,
        provider: "Local Qwen",
        answer
      });
    }

    if (provider === "deepseek") {
      const response = await deepseek.chat.completions.create({
        model: "deepseek-chat",
        messages: [
          {
            role: "user",
            content: prompt
          }
        ]
      });

      const answer =
        response.choices?.[0]?.message?.content || "";

      return res.json({
        success: true,
        provider: "DeepSeek",
        answer
      });
    }

    const response = await openai.chat.completions.create({
      model: "gpt-5.6",
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    });

    const answer =
      response.choices?.[0]?.message?.content || "";

    return res.json({
      success: true,
      provider: "OpenAI",
      answer
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running at http://localhost:${PORT}`);
});


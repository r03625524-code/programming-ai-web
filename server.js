const express = require("express");
const { execFile, spawn } = require("child_process");
const cors = require("cors");
require("dotenv").config();

const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const deepseek = process.env.DEEPSEEK_API_KEY
  ? new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: "https://api.deepseek.com"
    })
  : null;

const groq = process.env.GROQ_API_KEY ? new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" }) : null;
const openrouter = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1"
});


const CODING_DEBUG_PROMPT = `
You are a precise programming debugging assistant.

Your job is to fix the user's existing code without changing its intended behavior.

STRICT RULES:
- Read the COMPLETE original code before making changes.
- Identify the ACTUAL cause of the reported error.
- Make the MINIMUM necessary changes to fix that error.
- Preserve the original program's purpose and behavior.
- Do NOT invent unrelated code.
- Do NOT replace the program with a different example.
- Do NOT add arbitrary values such as 42.
- Do NOT remove working code unless it is causing the reported error.
- If a variable is undefined, define it appropriately or correct its reference.
- Return the COMPLETE corrected code, not only the changed line.
- The corrected code MUST be runnable.
- Do not return the original broken code unchanged.

Required format:
1. What is wrong:
2. Why it happened:
3. Corrected code:
4. Short explanation:

Put the COMPLETE corrected code inside ONE fenced code block.
`;



const AI_PROVIDERS = {
  local: {
    name: "Local Qwen",
    type: "local",
    model: null
  },
  groq: {
    name: "Groq",
    type: "openai-compatible",
    model: "openai/gpt-oss-20b"
  },
  openrouter: {
    name: "OpenRouter Free",
    type: "openai-compatible",
    model: "cohere/north-mini-code:free"
  },
  deepseek: {
    name: "DeepSeek",
    type: "openai-compatible",
    model: "deepseek-chat"
  },
  openai: {
    name: "OpenAI",
    type: "openai-compatible",
    model: "gpt-5.6"
  }
};

async function callAIProvider(provider, messages, options = {}) {
  const config = AI_PROVIDERS[provider];

  if (!config) {
    throw new Error(`Unsupported AI provider: ${provider}`);
  }

  const temperature = options.temperature ?? 0.7;
  const max_tokens = options.max_tokens ?? 1024;

  if (config.type === "local") {
    const response = await fetch("http://127.0.0.1:8080/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messages,
        temperature,
        max_tokens
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error?.message || `Local AI HTTP ${response.status}`
      );
    }

    return {
      provider: config.name,
      answer:
        data.choices?.[0]?.message?.content ||
        data.choices?.[0]?.message?.reasoning ||
        ""
    };
  }

  const clients = {
    openai,
    deepseek,
    groq,
    openrouter
  };

  const client = clients[provider];

  if (!client) {
    throw new Error(`AI provider "${provider}" is not configured.`);
  }

  const response = await client.chat.completions.create({
    model: config.model,
    messages,
    temperature,
    max_tokens
  });

  return {
    provider: config.name,
    answer:
      response.choices?.[0]?.message?.content ||
      response.choices?.[0]?.message?.reasoning ||
      ""
  };
}

app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    message: "Programming AI server is running"
  });
});


app.post("/api/ai-chat", async (req, res) => {
  try {
    const { message, provider, history = [] } = req.body;
    const currentCode = req.body.code || "";

    const editWords =
      /\b(fix|change|add|remove|modify|edit|update|rewrite|correct|debug|replace|delete|generate|create|write)\b.*\b(code|coding|program|programming|function|class|script|html|css|javascript|python|java|c\+\+)\b|\b(code|coding|program|programming|function|class|script|html|css|javascript|python|java|c\+\+)\b.*\b(fix|change|add|remove|modify|edit|update|rewrite|correct|debug|replace|delete|generate|create|write)\b/i;

    const isCodeRequest = editWords.test(message);

    const editPrompt = isCodeRequest
      ? "\n\nCURRENT CODE:\n" + currentCode +
        "\n\nIMPORTANT CODE EDIT RULE: Return ONLY the COMPLETE corrected code inside <CODE>...</CODE>. Do not put explanations before or after the CODE tags. Preserve the requested programming language."
      : "";

    if (!message) {
      return res.status(400).json({
        success: false,
        message: "Message is required"
      });
    }

    const cleanHistory = Array.isArray(history)
      ? history.filter(
          h =>
            h &&
            (h.role === "user" || h.role === "assistant") &&
            typeof h.content === "string"
        )
      : [];

    const messages = [
      {
        role: "system",
        content:
          "You are a helpful conversational AI assistant. Follow the user's words exactly. For normal conversation, reply naturally and briefly in plain text. Example: if the user says My name is Rk, reply Nice to meet you, Rk! Example: if the user asks What is my name?, reply Your name is Rk. Example: if the user says Hello, reply Hello! Never turn normal conversation into programming code. Never use <CODE> tags for normal conversation. Only use <CODE>...</CODE> when the user clearly asks for a programming task such as fixing, changing, adding, removing, writing, creating, generating, or debugging code. If the user asks for programming and CURRENT CODE is provided, return the complete corrected code inside <CODE>...</CODE>."
      },
      {
        role: "user",
        content:
          "Previous conversation:\n" +
          cleanHistory.map(h => h.role + ": " + h.content).join("\n") +
          "\n\nCurrent user message:\n" +
          message +
          editPrompt
      }
    ];

    const result = await callAIProvider(provider || "local", messages, {
      temperature: 0.7,
      max_tokens: 1024
    });

    return res.json({
      success: true,
      provider: result.provider,
      answer: result.answer
    });

  } catch (error) {
    console.error("AI CHAT ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "AI chat failed"
    });
  }
});

app.post("/api/ask-ai", async (req, res) => {
  try {
    const { code, error, provider } = req.body;

    console.log("PROVIDER:", provider);

    if (!code) {
      return res.status(400).json({
        success: false,
        message: "Code is required"
      });
    }

    const prompt = CODING_DEBUG_PROMPT + `

CODE:
${code}

ERROR:
${error || "No error provided"}
`;

    const result = await callAIProvider(provider || "local", [
      {
        role: "user",
        content: prompt
      }
    ], {
      temperature: 0.2,
      max_tokens: 1024
    });

    return res.json({
      success: true,
      provider: result.provider,
      answer: result.answer
    });

  } catch (err) {
    console.error("ASK AI ERROR:", err);

    return res.status(500).json({
      success: false,
      message: err.message || "AI request failed"
    });
  }
});

app.post("/api/run-java", (req, res) => {
  if (process.env.RENDER) {
    return res.status(403).json({
      success: false,
      error: "Java execution is available only in local Termux mode."
    });
  }

  const code = req.body?.code;
  if (typeof code !== "string" || !code.trim()) {
    return res.status(400).json({
      success: false,
      error: "Java code is required."
    });
  }

  const fs = require("fs");
  const os = require("os");
  const path = require("path");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "programming-ai-java-"));
  const javaFile = path.join(tempDir, "Main.java");

  fs.writeFileSync(javaFile, code, "utf8");

  const cleanup = () => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  };

  execFile("javac", ["Main.java"], {
    cwd: tempDir,
    timeout: 10000
  }, (compileError, stdout, stderr) => {
    if (compileError) {
      cleanup();
      return res.json({
        success: false,
        error: stderr || compileError.message
      });
    }

    execFile("java", ["Main"], {
      cwd: tempDir,
      timeout: 5000
    }, (runError, runStdout, runStderr) => {
      cleanup();

      if (runError) {
        return res.json({
          success: false,
          error: runStderr || runError.message
        });
      }

      res.json({
        success: true,
        output: runStdout || runStderr || ""
      });
    });
  });
});


app.post("/api/run-c", (req, res) => {
  if (process.env.RENDER) {
    return res.status(403).json({
      success: false,
      error: "C execution is available locally only."
    });
  }

  const code = req.body?.code;

  if (typeof code !== "string" || !code.trim()) {
    return res.status(400).json({
      success: false,
      error: "C code is required."
    });
  }

  const fs = require("fs");
  const os = require("os");
  const path = require("path");

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "programming-ai-c-")
  );

  const cFile = path.join(tempDir, "main.c");
  const outputFile = path.join(tempDir, "main");

  fs.writeFileSync(cFile, code, "utf8");

  const cleanup = () => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  };

  execFile("clang", [cFile, "-o", outputFile], {
    timeout: 10000
  }, (compileError, stdout, stderr) => {
    if (compileError) {
      cleanup();
      return res.json({
        success: false,
        error: stderr || compileError.message
      });
    }

    execFile(outputFile, [], {
      timeout: 5000
    }, (runError, runStdout, runStderr) => {
      cleanup();

      if (runError) {
        return res.json({
          success: false,
          error: runStderr || runError.message
        });
      }

      res.json({
        success: true,
        output: runStdout || runStderr || ""
      });
    });
  });
});


app.post("/api/run-cpp", (req, res) => {
  if (process.env.RENDER) {
    return res.status(403).json({
      success: false,
      error: "C++ execution is available locally only."
    });
  }

  const code = req.body?.code;

  if (typeof code !== "string" || !code.trim()) {
    return res.status(400).json({
      success: false,
      error: "C++ code is required."
    });
  }

  const fs = require("fs");
  const os = require("os");
  const path = require("path");

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "programming-ai-cpp-")
  );

  const cppFile = path.join(tempDir, "main.cpp");
  const outputFile = path.join(tempDir, "main");

  fs.writeFileSync(cppFile, code, "utf8");

  const cleanup = () => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  };

  execFile("g++", [cppFile, "-o", outputFile], {
    timeout: 10000
  }, (compileError, stdout, stderr) => {
    if (compileError) {
      cleanup();
      return res.json({
        success: false,
        error: stderr || compileError.message
      });
    }

    execFile(outputFile, [], {
      timeout: 5000
    }, (runError, runStdout, runStderr) => {
      cleanup();

      if (runError) {
        return res.json({
          success: false,
          error: runStderr || runError.message
        });
      }

      res.json({
        success: true,
        output: runStdout || runStderr || ""
      });
    });
  });
});


app.post("/api/run-go", (req, res) => {
  if (process.env.RENDER) {
    return res.status(403).json({
      success: false,
      error: "Go execution is available locally only."
    });
  }

  const code = req.body?.code;

  if (typeof code !== "string" || !code.trim()) {
    return res.status(400).json({
      success: false,
      error: "Go code is required."
    });
  }

  const fs = require("fs");
  const os = require("os");
  const path = require("path");

  const tempDir = fs.mkdtempSync(
    path.join(process.cwd(), ".go-run-")
  );

  const goFile = path.join(tempDir, "main.go");
  const outputFile = path.join(tempDir, "main");

  fs.writeFileSync(goFile, code, "utf8");

  const cleanup = () => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  };

  execFile("go", ["build", "-o", outputFile, goFile], {
    cwd: tempDir,
    timeout: 15000
  }, (compileError, stdout, stderr) => {
    if (compileError) {
      cleanup();
      return res.json({
        success: false,
        error: stderr || compileError.message
      });
    }

    execFile(outputFile, [], {
      cwd: tempDir,
      timeout: 5000
    }, (runError, runStdout, runStderr) => {
      cleanup();

      if (runError) {
        return res.json({
          success: false,
          error: runStderr || runError.message
        });
      }

      res.json({
        success: true,
        output: runStdout || runStderr || ""
      });
    });
  });
});


app.post("/api/run-rust", (req, res) => {
  if (process.env.RENDER) {
    return res.status(403).json({
      success: false,
      error: "Rust execution is available locally only."
    });
  }

  const code = req.body?.code;

  if (typeof code !== "string" || !code.trim()) {
    return res.status(400).json({
      success: false,
      error: "Rust code is required."
    });
  }

  const fs = require("fs");
  const os = require("os");
  const path = require("path");

  const tempDir = fs.mkdtempSync(
    path.join(process.cwd(), ".rust-run-")
  );

  const rustFile = path.join(tempDir, "main.rs");
  const outputFile = path.join(tempDir, "main");

  fs.writeFileSync(rustFile, code, "utf8");

  const cleanup = () => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  };

  execFile("rustc", [rustFile, "-o", outputFile], {
    cwd: tempDir,
    timeout: 15000
  }, (compileError, stdout, stderr) => {
    if (compileError) {
      cleanup();
      return res.json({
        success: false,
        error: stderr || compileError.message
      });
    }

    execFile(outputFile, [], {
      cwd: tempDir,
      timeout: 5000
    }, (runError, runStdout, runStderr) => {
      cleanup();

      if (runError) {
        return res.json({
          success: false,
          error: runStderr || runError.message
        });
      }

      res.json({
        success: true,
        output: runStdout || runStderr || ""
      });
    });
  });
});


app.post("/api/run-php", (req, res) => {
  if (process.env.RENDER) {
    return res.status(403).json({
      success: false,
      error: "PHP execution is available locally only."
    });
  }

  const code = req.body?.code;

  if (typeof code !== "string" || !code.trim()) {
    return res.status(400).json({
      success: false,
      error: "PHP code is required."
    });
  }

  const fs = require("fs");
  const os = require("os");
  const path = require("path");

  const tempDir = fs.mkdtempSync(
    path.join(process.cwd(), ".php-run-")
  );

  const phpFile = path.join(tempDir, "main.php");

  fs.writeFileSync(phpFile, code, "utf8");

  const cleanup = () => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  };

  execFile("php", [phpFile], {
    cwd: tempDir,
    timeout: 5000
  }, (runError, stdout, stderr) => {
    cleanup();

    if (runError) {
      return res.json({
        success: false,
        error: stderr || runError.message
      });
    }

    res.json({
      success: true,
      output: stdout || stderr || ""
    });
  });
});


app.post("/api/run-ruby", (req, res) => {
  if (process.env.RENDER) {
    return res.status(403).json({
      success: false,
      error: "Ruby execution is available locally only."
    });
  }

  const code = req.body?.code;

  if (typeof code !== "string" || !code.trim()) {
    return res.status(400).json({
      success: false,
      error: "Ruby code is required."
    });
  }

  const fs = require("fs");
  const path = require("path");

  const tempDir = fs.mkdtempSync(
    path.join(process.cwd(), ".ruby-run-")
  );

  const rubyFile = path.join(tempDir, "main.rb");

  fs.writeFileSync(rubyFile, code, "utf8");

  const cleanup = () => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  };

  execFile("ruby", [rubyFile], {
    cwd: tempDir,
    timeout: 5000
  }, (runError, stdout, stderr) => {
    cleanup();

    if (runError) {
      return res.json({
        success: false,
        error: stderr || runError.message
      });
    }

    res.json({
      success: true,
      output: stdout || stderr || ""
    });
  });
});


app.post("/api/run-kotlin", (req, res) => {
  if (process.env.RENDER) {
    return res.status(403).json({
      success: false,
      error: "Kotlin execution is available locally only."
    });
  }

  const code = req.body?.code;

  if (typeof code !== "string" || !code.trim()) {
    return res.status(400).json({
      success: false,
      error: "Kotlin code is required."
    });
  }

  const fs = require("fs");
  const path = require("path");

  const tempDir = path.join(process.cwd(), "kotlin-run");
  fs.mkdirSync(tempDir, { recursive: true });

  const kotlinFile = path.join(tempDir, "Main.kt");
  const jarFile = path.join(tempDir, "main.jar");

  fs.writeFileSync(kotlinFile, code, "utf8");

  const compile = spawn("kotlinc", [
    kotlinFile,
    "-include-runtime",
    "-d",
    jarFile
  ]);

  let compileOut = "";
  let compileErr = "";

  compile.stdout.on("data", data => compileOut += data.toString());
  compile.stderr.on("data", data => compileErr += data.toString());

  compile.on("error", error => {
    res.json({
      success: false,
      error: error.message
    });
  });

  compile.on("close", code => {
    if (code !== 0) {
      return res.json({
        success: false,
        error: compileErr || compileOut || "Kotlin compilation failed."
      });
    }

    const run = spawn("java", ["-jar", jarFile]);

    let runOut = "";
    let runErr = "";

    run.stdout.on("data", data => runOut += data.toString());
    run.stderr.on("data", data => runErr += data.toString());

    run.on("error", error => {
      res.json({
        success: false,
        error: error.message
      });
    });

    run.on("close", code => {
      if (code !== 0) {
        return res.json({
          success: false,
          error: runErr || "Kotlin program failed."
        });
      }

      res.json({
        success: true,
        output: runOut || runErr || ""
      });
    });
  });
});

app.post("/api/run-csharp", (req, res) => {
  if (process.env.RENDER) {
    return res.status(403).json({
      success: false,
      error: "C# execution is available locally only."
    });
  }

  const code = req.body?.code;

  if (typeof code !== "string" || !code.trim()) {
    return res.status(400).json({
      success: false,
      error: "C# code is required."
    });
  }

  const fs = require("fs");
  const path = require("path");

  const tempDir = fs.mkdtempSync(
    path.join(process.cwd(), ".cs-run-")
  );

  const csFile = path.join(tempDir, "Main.cs");
  const exeFile = path.join(tempDir, "Main.exe");

  fs.writeFileSync(csFile, code, "utf8");

  const compile = spawn("mcs", [
    csFile,
    "-out:" + exeFile
  ]);

  let compileOut = "";
  let compileErr = "";

  compile.stdout.on("data", data => {
    compileOut += data.toString();
  });

  compile.stderr.on("data", data => {
    compileErr += data.toString();
  });

  compile.on("error", error => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    return res.json({
      success: false,
      error: error.message
    });
  });

  compile.on("close", code => {
    if (code !== 0) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return res.json({
        success: false,
        error: compileErr || compileOut || "C# compilation failed."
      });
    }

    const run = spawn("mono", [exeFile]);

    let runOut = "";
    let runErr = "";

    run.stdout.on("data", data => {
      runOut += data.toString();
    });

    run.stderr.on("data", data => {
      runErr += data.toString();
    });

    run.on("error", error => {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return res.json({
        success: false,
        error: error.message
      });
    });

    run.on("close", runCode => {
      fs.rmSync(tempDir, { recursive: true, force: true });

      if (runCode !== 0) {
        return res.json({
          success: false,
          error: runErr || "C# program failed."
        });
      }

      return res.json({
        success: true,
        output: runOut || runErr || ""
      });
    });
  });
});

app.post("/api/run-typescript", (req, res) => {
  if (process.env.RENDER) {
    return res.status(403).json({
      success: false,
      error: "TypeScript execution is available locally only."
    });
  }

  const code = req.body?.code;

  if (typeof code !== "string" || !code.trim()) {
    return res.status(400).json({
      success: false,
      error: "TypeScript code is required."
    });
  }

  const fs = require("fs");
  const path = require("path");

  const tempDir = fs.mkdtempSync(
    path.join(process.cwd(), ".ts-run-")
  );

  const tsFile = path.join(tempDir, "main.ts");
  const outDir = path.join(tempDir, "out");
  const jsFile = path.join(outDir, "main.js");

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(tsFile, code, "utf8");

  const compile = spawn(
    process.execPath,
    [
      path.join(process.cwd(), "node_modules", "typescript", "bin", "tsc"),
      tsFile,
      "--target", "ES2020",
      "--module", "commonjs",
      "--outDir", outDir
    ]
  );

  let compileOut = "";
  let compileErr = "";

  compile.stdout.on("data", data => {
    compileOut += data.toString();
  });

  compile.stderr.on("data", data => {
    compileErr += data.toString();
  });

  compile.on("error", error => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    return res.json({
      success: false,
      error: error.message
    });
  });

  compile.on("close", code => {
    if (code !== 0) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return res.json({
        success: false,
        error: compileErr || compileOut || "TypeScript compilation failed."
      });
    }

    const run = spawn(process.execPath, [jsFile]);

    let runOut = "";
    let runErr = "";

    run.stdout.on("data", data => {
      runOut += data.toString();
    });

    run.stderr.on("data", data => {
      runErr += data.toString();
    });

    run.on("error", error => {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return res.json({
        success: false,
        error: error.message
      });
    });

    run.on("close", runCode => {
      fs.rmSync(tempDir, { recursive: true, force: true });

      if (runCode !== 0) {
        return res.json({
          success: false,
          error: runErr || "TypeScript program failed."
        });
      }

      return res.json({
        success: true,
        output: runOut || runErr || ""
      });
    });
  });
});


app.post("/api/run-sql", (req, res) => {
  if (process.env.RENDER) {
    return res.status(403).json({
      success: false,
      error: "SQL execution is available locally only."
    });
  }

  const code = req.body?.code;

  if (typeof code !== "string" || !code.trim()) {
    return res.status(400).json({
      success: false,
      error: "SQL code is required."
    });
  }

  const fs = require("fs");
  const path = require("path");
  const { spawn } = require("child_process");

  const tempDir = path.join(process.cwd(), "sql-run");
  fs.mkdirSync(tempDir, { recursive: true });

  const dbFile = path.join(tempDir, "database.db");

  const sqlite = spawn("sqlite3", [
    "-header",
    "-box",
    dbFile
  ]);

  let output = "";
  let error = "";

  sqlite.stdout.on("data", data => output += data.toString());
  sqlite.stderr.on("data", data => error += data.toString());

  sqlite.on("error", err => {
    res.json({
      success: false,
      error: err.message
    });
  });

  sqlite.stdin.write(code);
  sqlite.stdin.end();

  sqlite.on("close", code => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}

    if (code !== 0) {
      return res.json({
        success: false,
        error: error || "SQL execution failed."
      });
    }

    res.json({
      success: true,
      output: output || ""
    });
  });
});


app.post("/api/run-bash", (req, res) => {
  if (process.env.RENDER) {
    return res.status(403).json({
      success: false,
      error: "Bash execution is available locally only."
    });
  }

  const code = req.body?.code;

  if (typeof code !== "string" || !code.trim()) {
    return res.status(400).json({
      success: false,
      error: "Bash code is required."
    });
  }

  const { spawn } = require("child_process");

  const bash = spawn("bash", ["-c", code]);

  let output = "";
  let error = "";
  let finished = false;

  const timer = setTimeout(() => {
    if (!finished) {
      bash.kill("SIGKILL");
      finished = true;

      res.json({
        success: false,
        error: "Bash execution timed out (5 seconds)."
      });
    }
  }, 5000);

  bash.stdout.on("data", data => output += data.toString());
  bash.stderr.on("data", data => error += data.toString());

  bash.on("error", err => {
    clearTimeout(timer);

    if (finished) return;
    finished = true;

    res.json({
      success: false,
      error: err.message
    });
  });

  bash.on("close", code => {
    clearTimeout(timer);

    if (finished) return;
    finished = true;

    if (code !== 0) {
      return res.json({
        success: false,
        error: error || `Bash exited with code ${code}.`
      });
    }

    res.json({
      success: true,
      output: output || error || ""
    });
  });
});


app.post("/api/install-npm", (req, res) => {
  if (process.env.RENDER) {
    return res.status(403).json({
      success: false,
      error: "Package installation is available locally only."
    });
  }

  const packageName = req.body?.package;

  if (typeof packageName !== "string" ||
      !/^[a-zA-Z0-9@._\/-]+$/.test(packageName)) {
    return res.status(400).json({
      success: false,
      error: "Invalid npm package name."
    });
  }

  const { spawn } = require("child_process");

  const npm = spawn("npm", [
    "install",
    packageName,
    "--no-audit",
    "--no-fund"
  ], {
    cwd: process.cwd()
  });

  let output = "";
  let error = "";

  npm.stdout.on("data", data => output += data.toString());
  npm.stderr.on("data", data => error += data.toString());

  const timer = setTimeout(() => {
    npm.kill("SIGKILL");
    res.json({
      success: false,
      error: "npm installation timed out."
    });
  }, 30000);

  npm.on("error", err => {
    clearTimeout(timer);
    res.json({
      success: false,
      error: err.message
    });
  });

  npm.on("close", code => {
    clearTimeout(timer);

    if (code !== 0) {
      return res.json({
        success: false,
        error: error || output || "npm installation failed."
      });
    }

    res.json({
      success: true,
      output: output || "Package installed successfully."
    });
  });
});


app.post("/api/install-pip", (req, res) => {
  if (process.env.RENDER) {
    return res.status(403).json({
      success: false,
      error: "pip package installation is available locally only."
    });
  }

  const packageName = req.body?.package;

  if (typeof packageName !== "string" ||
      !/^[a-zA-Z0-9._-]+$/.test(packageName)) {
    return res.status(400).json({
      success: false,
      error: "Invalid Python package name."
    });
  }

  const { spawn } = require("child_process");

  const pip = spawn("python", [
    "-m",
    "pip",
    "install",
    packageName
  ]);

  let output = "";
  let error = "";

  pip.stdout.on("data", data => output += data.toString());
  pip.stderr.on("data", data => error += data.toString());

  const timer = setTimeout(() => {
    pip.kill("SIGKILL");
    res.json({
      success: false,
      error: "pip installation timed out."
    });
  }, 30000);

  pip.on("error", err => {
    clearTimeout(timer);
    res.json({
      success: false,
      error: err.message
    });
  });

  pip.on("close", code => {
    clearTimeout(timer);

    if (code !== 0) {
      return res.json({
        success: false,
        error: error || output || "pip installation failed."
      });
    }

    res.json({
      success: true,
      output: output || "Package installed successfully."
    });
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running at http://localhost:${PORT}`);
});


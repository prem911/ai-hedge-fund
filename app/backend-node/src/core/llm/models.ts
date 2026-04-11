import { ChatOpenAI, AzureChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGroq } from "@langchain/groq";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOllama } from "@langchain/ollama";
import { ChatXAI } from "@langchain/xai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

// ─── ModelProvider ─────────────────────────────────────────────────────────────
export enum ModelProvider {
  OPENAI = "OpenAI",
  ANTHROPIC = "Anthropic",
  GROQ = "Groq",
  GOOGLE = "Google",
  OLLAMA = "Ollama",
  DEEPSEEK = "DeepSeek",
  XAI = "xAI",
  GIGACHAT = "GigaChat",
  AZURE_OPENAI = "Azure OpenAI",
  OPENROUTER = "OpenRouter",
  ALIBABA = "Alibaba",
  META = "Meta",
  MISTRAL = "Mistral",
}

// ─── getLlm factory ────────────────────────────────────────────────────────────
export function getLlm(
  modelName: string,
  modelProvider: ModelProvider | string,
  apiKeys?: Record<string, string>
): BaseChatModel {
  const keys = apiKeys ?? {};

  switch (modelProvider) {
    case ModelProvider.OPENAI: {
      const apiKey = keys["OPENAI_API_KEY"] ?? process.env["OPENAI_API_KEY"];
      if (!apiKey) throw new Error("OpenAI API key not found. Please set OPENAI_API_KEY.");
      const baseUrl = process.env["OPENAI_API_BASE"];
      return new ChatOpenAI({ model: modelName, apiKey, configuration: baseUrl ? { baseURL: baseUrl } : undefined });
    }

    case ModelProvider.ANTHROPIC: {
      const apiKey = keys["ANTHROPIC_API_KEY"] ?? process.env["ANTHROPIC_API_KEY"];
      if (!apiKey) throw new Error("Anthropic API key not found. Please set ANTHROPIC_API_KEY.");
      return new ChatAnthropic({ model: modelName, apiKey });
    }

    case ModelProvider.GROQ: {
      const apiKey = keys["GROQ_API_KEY"] ?? process.env["GROQ_API_KEY"];
      if (!apiKey) throw new Error("Groq API key not found. Please set GROQ_API_KEY.");
      return new ChatGroq({ model: modelName, apiKey });
    }

    case ModelProvider.GOOGLE: {
      const apiKey = keys["GOOGLE_API_KEY"] ?? process.env["GOOGLE_API_KEY"];
      if (!apiKey) throw new Error("Google API key not found. Please set GOOGLE_API_KEY.");
      return new ChatGoogleGenerativeAI({ model: modelName, apiKey });
    }

    case ModelProvider.OLLAMA: {
      const ollamaHost = process.env["OLLAMA_HOST"] ?? "localhost";
      const baseUrl = process.env["OLLAMA_BASE_URL"] ?? `http://${ollamaHost}:11434`;
      return new ChatOllama({ model: modelName, baseUrl });
    }

    case ModelProvider.DEEPSEEK: {
      const apiKey = keys["DEEPSEEK_API_KEY"] ?? process.env["DEEPSEEK_API_KEY"];
      if (!apiKey) throw new Error("DeepSeek API key not found. Please set DEEPSEEK_API_KEY.");
      return new ChatOpenAI({
        model: modelName,
        apiKey,
        configuration: { baseURL: "https://api.deepseek.com" },
      });
    }

    case ModelProvider.XAI: {
      const apiKey = keys["XAI_API_KEY"] ?? process.env["XAI_API_KEY"];
      if (!apiKey) throw new Error("xAI API key not found. Please set XAI_API_KEY.");
      return new ChatXAI({ model: modelName, apiKey });
    }

    case ModelProvider.GIGACHAT: {
      // GigaChat has no official LangChain.js package — stub with TODO
      // TODO: Implement GigaChat when an official JS package becomes available.
      // For now, fall back to OpenAI-compatible interface if credentials are set
      const apiKey = keys["GIGACHAT_API_KEY"] ?? process.env["GIGACHAT_API_KEY"] ?? process.env["GIGACHAT_CREDENTIALS"];
      if (!apiKey) throw new Error("GigaChat credentials not found. Please set GIGACHAT_API_KEY.");
      console.warn("GigaChat: No official LangChain.js package. Using OpenAI-compatible stub.");
      return new ChatOpenAI({ model: modelName, apiKey });
    }

    case ModelProvider.AZURE_OPENAI: {
      const apiKey = process.env["AZURE_OPENAI_API_KEY"];
      if (!apiKey) throw new Error("Azure OpenAI API key not found. Please set AZURE_OPENAI_API_KEY.");
      const azureEndpoint = process.env["AZURE_OPENAI_ENDPOINT"];
      if (!azureEndpoint) throw new Error("Azure OpenAI endpoint not found. Please set AZURE_OPENAI_ENDPOINT.");
      const azureDeployment = process.env["AZURE_OPENAI_DEPLOYMENT_NAME"];
      if (!azureDeployment) throw new Error("Azure OpenAI deployment name not found. Please set AZURE_OPENAI_DEPLOYMENT_NAME.");
      return new AzureChatOpenAI({
        azureOpenAIEndpoint: azureEndpoint,
        azureOpenAIApiDeploymentName: azureDeployment,
        apiKey,
        openAIApiVersion: "2024-10-21",
      });
    }

    case ModelProvider.OPENROUTER: {
      const apiKey = keys["OPENROUTER_API_KEY"] ?? process.env["OPENROUTER_API_KEY"];
      if (!apiKey) throw new Error("OpenRouter API key not found. Please set OPENROUTER_API_KEY.");
      const siteUrl = process.env["YOUR_SITE_URL"] ?? "https://github.com/virattt/ai-hedge-fund";
      const siteName = process.env["YOUR_SITE_NAME"] ?? "AI Hedge Fund";
      return new ChatOpenAI({
        model: modelName,
        apiKey,
        configuration: {
          baseURL: "https://openrouter.ai/api/v1",
          defaultHeaders: {
            "HTTP-Referer": siteUrl,
            "X-Title": siteName,
          },
        },
      });
    }

    default:
      throw new Error(
        `Unsupported model provider: ${modelProvider}. Supported providers: ${Object.values(ModelProvider).join(", ")}`
      );
  }
}

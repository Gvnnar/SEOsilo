import OpenAI from "openai";
import { z } from "zod";
import type { MergedContentResult } from "./types";

const MergeSchema = z.object({
  title: z.string(),
  metaDescription: z.string(),
  content: z.string(),
});

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "anthropic/claude-opus-5";

export class ContentMergingUnavailableError extends Error {}

// Merging near-duplicate pages into one is inherently a generative
// rewriting task, unlike lexical/embeddings clustering - there's no
// meaningful offline fallback, so this always requires an LLM call.
export function isContentMergingAvailable(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

function getClient(): OpenAI {
  return new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: OPENROUTER_BASE_URL,
  });
}

export interface MergeSource {
  url: string;
  label: string;
  content: string;
}

export async function mergeContent(
  sources: MergeSource[],
  pageContext?: string,
): Promise<MergedContentResult> {
  if (!isContentMergingAvailable()) {
    throw new ContentMergingUnavailableError(
      "Brak skonfigurowanego OPENROUTER_API_KEY - łączenie treści w jedną wymaga modelu AI.",
    );
  }
  if (sources.length < 2) {
    throw new Error("Do połączenia potrzeba co najmniej dwóch źródeł treści.");
  }

  // The source with the most existing content becomes the canonical URL
  // that keeps its ranking history and gets the merged content published
  // on it - standard consolidation practice is to redirect the weaker
  // pages into the strongest one rather than invent a brand-new URL.
  const primary = sources.reduce((best, s) => (s.content.length > best.content.length ? s : best));

  const client = getClient();
  const model = process.env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL;

  const contextLine = pageContext?.trim() ? `Kontekst witryny/tematu: "${pageContext.trim()}".` : "";

  const sourcesBlock = sources
    .map((s, i) => `--- ŹRÓDŁO ${i + 1}: ${s.label} (${s.url}) ---\n${s.content}`)
    .join("\n\n");

  const systemPrompt =
    "Jesteś ekspertem SEO i copywriterem specjalizującym się w konsolidacji treści (content " +
    "consolidation) - łączeniu kilku nakładających się tematycznie podstron w jedną, pełniejszą i " +
    "niepowielającą się treść, zgodnie ze standardową praktyką SEO przy kanibalizacji słów " +
    "kluczowych: scal unikalną wartość każdego źródła w jeden spójny, wyczerpujący artykuł, usuń " +
    "powtórzenia, zachowaj wszystkie unikalne fakty, sekcje i przykłady, zorganizuj logicznie " +
    "nagłówkami. Pisz w tym samym języku co źródła. Nie wymyślaj faktów, których nie ma w żadnym " +
    "źródle." +
    "\n\nOdpowiedz WYŁĄCZNIE poprawnym obiektem JSON, bez markdown i bez komentarzy, dokładnie w " +
    'formacie:\n{"title":"tytuł strony","metaDescription":"meta description (maks. ok. 160 ' +
    'znaków)","content":"pełna treść scalonego artykułu w Markdown, z nagłówkami"}';

  const response = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content:
          `${contextLine}\n\nPoniżej ${sources.length} nakładające się tematycznie podstrony do ` +
          `scalenia w jedną:\n\n${sourcesBlock}`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) {
    throw new Error("Model nie zwrócił żadnej odpowiedzi.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Model nie zwrócił poprawnego JSON-a.");
  }

  const result = MergeSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("Odpowiedź modelu nie pasuje do oczekiwanego formatu scalonej treści.");
  }

  return {
    primaryUrl: primary.url,
    primaryLabel: primary.label,
    redirectFromUrls: sources.filter((s) => s.url !== primary.url).map((s) => s.url),
    title: result.data.title,
    metaDescription: result.data.metaDescription,
    content: result.data.content,
    sources: sources.map((s) => ({ url: s.url, label: s.label })),
  };
}

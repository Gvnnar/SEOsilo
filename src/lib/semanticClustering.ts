import OpenAI from "openai";
import { z } from "zod";
import type { PhraseCluster } from "./types";

const ClusterSchema = z.object({
  clusters: z
    .array(
      z.object({
        name: z.string(),
        mainPhrase: z.string(),
        phrases: z.array(z.string()).min(1),
      }),
    )
    .min(1),
});

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "anthropic/claude-opus-5";

export class SemanticClusteringUnavailableError extends Error {}

export function isSemanticClusteringAvailable(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

function getClient(): OpenAI {
  return new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: OPENROUTER_BASE_URL,
  });
}

export async function clusterSemantically(
  phrases: string[],
  pageContext?: string,
  contentKind: "phrases" | "pages" = "phrases",
): Promise<PhraseCluster[]> {
  if (!isSemanticClusteringAvailable()) {
    throw new SemanticClusteringUnavailableError(
      "Brak skonfigurowanego OPENROUTER_API_KEY - grupowanie semantyczne jest niedostępne.",
    );
  }

  const client = getClient();
  const model = process.env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL;

  const numberedPhrases = phrases.map((phrase, i) => `${i + 1}. ${phrase}`).join("\n");

  const contextLine = pageContext?.trim()
    ? `Kontekst strony/tematu, dla której tworzysz grupowanie: "${pageContext.trim()}". Grupuj i nazywaj klastry tak, aby były trafne względem tego kontekstu.`
    : "Nie podano dodatkowego kontekstu strony - grupuj wyłącznie na podstawie znaczenia fraz.";

  const subjectDescription =
    contentKind === "pages"
      ? "Każdy poniższy element to podsumowanie treści JEDNEJ realnej podstrony istniejącej witryny " +
        "(tytuł, meta description i nagłówki H1-H3, oddzielone znakiem „ · ”), a nie dosłowna fraza z " +
        "wyszukiwarki. Przeanalizuj treść każdej podstrony osobno i pogrupuj podstrony wg tematu, jakiego " +
        "faktycznie dotyczą - nie kieruj się tylko powtarzającymi się frazami marketingowymi z meta description."
      : "Grupujesz frazy kluczowe wpisywane w wyszukiwarkę.";

  const systemPrompt =
    "Jesteś ekspertem SEO specjalizującym się w grupowaniu treści w klastry/silosy tematyczne " +
    "na potrzeby planowania treści i architektury informacji serwisu. " +
    subjectDescription +
    " Grupujesz według intencji wyszukiwania i znaczenia semantycznego, nie tylko wspólnych słów. Każdy " +
    "element z wejścia musi trafić do dokładnie jednego klastra, zachowany w oryginalnym brzmieniu. Liczba " +
    "klastrów powinna być rozsądna - unikaj zarówno jednego wielkiego klastra, jak i osobnego klastra dla " +
    "każdego elementu; łącz te, które realnie odpowiadają na to samo zapytanie użytkownika lub temat podstrony." +
    "\n\nOdpowiedz WYŁĄCZNIE poprawnym obiektem JSON, bez markdown i bez komentarzy, dokładnie w formacie:\n" +
    '{"clusters":[{"name":"nazwa klastra","mainPhrase":"fraza główna","phrases":["fraza 1","fraza 2"]}]}';

  const taskLine =
    contentKind === "pages"
      ? "Pogrupuj poniższe podstrony (podsumowania ich treści) w klastry tematyczne"
      : "Pogrupuj poniższe frazy kluczowe w klastry tematyczne";

  const response = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `${contextLine}\n\n${taskLine}:\n\n${numberedPhrases}`,
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Model nie zwrócił żadnej odpowiedzi.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error("Model nie zwrócił poprawnego JSON-a.");
  }

  const parsed = ClusterSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Odpowiedź modelu nie pasuje do oczekiwanego formatu grupowania.");
  }

  return reconcileWithInput(parsed.data.clusters, phrases);
}

// Defensive pass: the model is instructed to preserve every input phrase
// exactly, but LLM output over a boundary is never guaranteed - repair any
// drift (typo'd/dropped/duplicated phrase) rather than losing user data.
function reconcileWithInput(
  clusters: { name: string; mainPhrase: string; phrases: string[] }[],
  inputPhrases: string[],
): PhraseCluster[] {
  const remaining = new Set(inputPhrases);
  const result: PhraseCluster[] = [];

  for (const cluster of clusters) {
    const keptPhrases = cluster.phrases.filter((phrase) => remaining.has(phrase));
    for (const phrase of keptPhrases) remaining.delete(phrase);
    if (keptPhrases.length === 0) continue;

    const mainPhrase = keptPhrases.includes(cluster.mainPhrase)
      ? cluster.mainPhrase
      : keptPhrases[0];

    result.push({ name: cluster.name, mainPhrase, phrases: keptPhrases });
  }

  if (remaining.size > 0) {
    const leftoverPhrases = inputPhrases.filter((phrase) => remaining.has(phrase));
    result.push({
      name: "Inne",
      mainPhrase: leftoverPhrases[0],
      phrases: leftoverPhrases,
    });
  }

  return result;
}

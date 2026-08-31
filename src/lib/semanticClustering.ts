import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { PhraseCluster } from "./types";

const ClusterSchema = z.object({
  clusters: z
    .array(
      z.object({
        name: z.string().describe("Krótka nazwa tematu klastra, np. 'Pielęgnacja trawnika'"),
        mainPhrase: z
          .string()
          .describe("Fraza główna klastra - najbardziej reprezentatywna, o najszerszym zasięgu"),
        phrases: z
          .array(z.string())
          .min(1)
          .describe("Wszystkie frazy wejściowe należące do tego klastra, dokładnie jak podane na wejściu"),
      }),
    )
    .min(1),
});

export class SemanticClusteringUnavailableError extends Error {}

export function isSemanticClusteringAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function clusterSemantically(
  phrases: string[],
  pageContext?: string,
): Promise<PhraseCluster[]> {
  if (!isSemanticClusteringAvailable()) {
    throw new SemanticClusteringUnavailableError(
      "Brak skonfigurowanego ANTHROPIC_API_KEY - grupowanie semantyczne jest niedostępne.",
    );
  }

  const client = new Anthropic();

  const numberedPhrases = phrases.map((phrase, i) => `${i + 1}. ${phrase}`).join("\n");

  const contextLine = pageContext?.trim()
    ? `Kontekst strony/tematu, dla której tworzysz grupowanie: "${pageContext.trim()}". Grupuj i nazywaj klastry tak, aby były trafne względem tego kontekstu.`
    : "Nie podano dodatkowego kontekstu strony - grupuj wyłącznie na podstawie znaczenia fraz.";

  const response = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 16000,
    output_config: {
      format: zodOutputFormat(ClusterSchema),
      effort: "medium",
    },
    system:
      "Jesteś ekspertem SEO specjalizującym się w grupowaniu fraz kluczowych w klastry/silosy tematyczne " +
      "na potrzeby planowania treści i architektury informacji serwisu. Grupujesz frazy według intencji " +
      "wyszukiwania i znaczenia semantycznego, nie tylko wspólnych słów. Każda fraza z wejścia musi trafić " +
      "do dokładnie jednego klastra, zachowana w oryginalnym brzmieniu. Liczba klastrów powinna być rozsądna " +
      "- unikaj zarówno jednego wielkiego klastra, jak i osobnego klastra dla każdej frazy; łącz frazy, które " +
      "realnie odpowiadają na to samo zapytanie użytkownika lub temat podstrony.",
    messages: [
      {
        role: "user",
        content:
          `${contextLine}\n\nPogrupuj poniższe frazy kluczowe w klastry tematyczne:\n\n${numberedPhrases}`,
      },
    ],
  });

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error("Claude nie zwrócił poprawnie sformatowanego wyniku grupowania.");
  }

  return reconcileWithInput(parsed.clusters, phrases);
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

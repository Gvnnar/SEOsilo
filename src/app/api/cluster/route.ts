import { NextResponse } from "next/server";
import { clusterLexically } from "@/lib/lexicalClustering";
import {
  clusterSemantically,
  isSemanticClusteringAvailable,
  SemanticClusteringUnavailableError,
} from "@/lib/semanticClustering";
import { MAX_PHRASES, type ClusterRequestBody, type ClusterResponse } from "@/lib/types";

export async function GET() {
  return NextResponse.json({ semanticAvailable: isSemanticClusteringAvailable() });
}

export async function POST(request: Request) {
  let body: ClusterRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Nieprawidłowy JSON w treści żądania." }, { status: 400 });
  }

  const method = body.method === "semantic" ? "semantic" : "lexical";
  const pageContext = typeof body.pageContext === "string" ? body.pageContext : undefined;

  const phrases = Array.from(
    new Set((body.phrases ?? []).map((p) => (typeof p === "string" ? p.trim() : "")).filter(Boolean)),
  );

  if (phrases.length === 0) {
    return NextResponse.json({ error: "Podaj co najmniej jedną frazę." }, { status: 400 });
  }

  if (phrases.length > MAX_PHRASES) {
    return NextResponse.json(
      { error: `Zbyt wiele fraz (max ${MAX_PHRASES}). Podano: ${phrases.length}.` },
      { status: 400 },
    );
  }

  try {
    const clusters =
      method === "semantic"
        ? await clusterSemantically(phrases, pageContext)
        : clusterLexically(phrases);

    const responseBody: ClusterResponse = { method, clusters };
    return NextResponse.json(responseBody);
  } catch (error) {
    if (error instanceof SemanticClusteringUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Cluster generation failed:", error);
    return NextResponse.json(
      { error: "Nie udało się wygenerować grupowania. Spróbuj ponownie." },
      { status: 500 },
    );
  }
}

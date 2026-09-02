// Average-link (UPGMA) agglomerative clustering, generic over whatever
// pairwise similarity function the caller supplies (token overlap, cosine
// similarity between embedding vectors, ...). Repeatedly merges the two
// groups with the highest *average* pairwise similarity, stopping once no
// pair clears the threshold. Single-link (union-find over any-pair-matches)
// chains unrelated items together transitively (A-B and B-C linked makes
// A-C the same group even if unrelated); averaging over every member pair
// avoids that chaining effect.
export function agglomerativeCluster(
  n: number,
  similarity: (i: number, j: number) => number,
  threshold: number,
): number[][] {
  interface ClusterNode {
    members: number[];
  }

  const active = new Map<number, ClusterNode>();
  for (let i = 0; i < n; i++) active.set(i, { members: [i] });

  // sumSim[a][b] = sum of similarity(i, j) over all original-item pairs
  // (i, j) with i in group a, j in group b.
  const sumSim = new Map<number, Map<number, number>>();
  const setSim = (a: number, b: number, v: number) => {
    if (!sumSim.has(a)) sumSim.set(a, new Map());
    if (!sumSim.has(b)) sumSim.set(b, new Map());
    sumSim.get(a)!.set(b, v);
    sumSim.get(b)!.set(a, v);
  };
  const getSim = (a: number, b: number) => sumSim.get(a)?.get(b) ?? 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      setSim(i, j, similarity(i, j));
    }
  }

  let nextId = n;
  while (active.size > 1) {
    const ids = Array.from(active.keys());
    let bestA = -1;
    let bestB = -1;
    let bestAvg = -Infinity;

    for (let x = 0; x < ids.length; x++) {
      for (let y = x + 1; y < ids.length; y++) {
        const a = ids[x];
        const b = ids[y];
        const sizeA = active.get(a)!.members.length;
        const sizeB = active.get(b)!.members.length;
        const avg = getSim(a, b) / (sizeA * sizeB);
        if (avg > bestAvg) {
          bestAvg = avg;
          bestA = a;
          bestB = b;
        }
      }
    }

    if (bestAvg < threshold) break;

    const nodeA = active.get(bestA)!;
    const nodeB = active.get(bestB)!;
    const mergedId = nextId++;

    for (const otherId of active.keys()) {
      if (otherId === bestA || otherId === bestB) continue;
      setSim(mergedId, otherId, getSim(bestA, otherId) + getSim(bestB, otherId));
    }

    sumSim.delete(bestA);
    sumSim.delete(bestB);
    for (const row of sumSim.values()) {
      row.delete(bestA);
      row.delete(bestB);
    }

    active.delete(bestA);
    active.delete(bestB);
    active.set(mergedId, { members: [...nodeA.members, ...nodeB.members] });
  }

  return Array.from(active.values()).map((node) => node.members);
}

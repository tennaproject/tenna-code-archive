export interface BuildPair {
  earlier: string;
  later: string;
}

interface BuildOptionAvailability {
  id: string;
  asEarlier: boolean;
  asLater: boolean;
}

export function normalizeBuildPair(
  newestFirstIds: readonly string[],
  earlier: string | undefined,
  later: string | undefined,
): BuildPair | undefined {
  if (earlier === undefined || later === undefined || earlier === later) return undefined;
  const earlierIndex = newestFirstIds.indexOf(earlier);
  const laterIndex = newestFirstIds.indexOf(later);
  if (earlierIndex === -1 || laterIndex === -1) return undefined;
  return earlierIndex > laterIndex ? { earlier, later } : { earlier: later, later: earlier };
}

export function buildOptionAvailability(
  newestFirstIds: readonly string[],
  pair: BuildPair,
): BuildOptionAvailability[] {
  const earlierIndex = newestFirstIds.indexOf(pair.earlier);
  const laterIndex = newestFirstIds.indexOf(pair.later);
  if (earlierIndex === -1 || laterIndex === -1 || earlierIndex <= laterIndex) return [];
  return newestFirstIds.map((id, index) => ({
    id,
    asEarlier: index > laterIndex,
    asLater: index < earlierIndex,
  }));
}

/**
 * Calls `fetch(from, to)` over [fromBlock, toBlock] in chunks of at most `chunk` blocks, halving the
 * chunk on an error. RPCs cap the eth_getLogs range (Moderato: 100,000 blocks, about 17 hours), so
 * one query from an old block fails outright.
 */
export async function scanBlocks(
  fromBlock: bigint,
  toBlock: bigint,
  fetch: (from: bigint, to: bigint) => Promise<void>,
  chunk = 50_000n,
): Promise<void> {
  for (let from = fromBlock; from <= toBlock; ) {
    const to = from + chunk - 1n < toBlock ? from + chunk - 1n : toBlock
    try {
      await fetch(from, to)
      from = to + 1n
    } catch (e) {
      if (chunk <= 100n) throw e
      chunk /= 2n
    }
  }
}
